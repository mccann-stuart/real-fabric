import {
  FilterType,
  FullTrackName,
  GroupOrder,
  LiveTrackSource,
  Location,
  MOQtailClient,
  MoqtObject,
  ObjectForwardingPreference,
  RequestError,
  Tuple,
} from "moqtail";

export interface TrackAddress {
  namespace: string;
  name: string;
}

export interface MediaObject {
  groupId: number;
  objectId: number;
  payload: Uint8Array;
}

export interface MoqSessionStats {
  state: "idle" | "connecting" | "connected" | "closed" | "failed";
  draft: string;
  endpoint: string;
  connectedAt: number | null;
  publishedObjects: number;
  subscribedObjects: number;
  transportRttMs: number | "Not exposed";
}

export class MoqTransportError extends Error {
  constructor(
    readonly code: "draft_mismatch" | "draft_unavailable" | "relay_unavailable" | "protocol_error",
    message: string,
  ) {
    super(message);
  }
}

interface Publication {
  address: TrackAddress;
  fullName: FullTrackName;
  controller: ReadableStreamDefaultController<MoqtObject>;
}

export class MoqTransportAdapter {
  private client: MOQtailClient | null = null;
  private publications = new Map<string, Publication>();
  private subscriptions = new Map<string, bigint>();
  private namespaceCancels = new Map<string, () => Promise<void>>();
  private nextAlias = 1n;
  private stats: MoqSessionStats = {
    state: "idle",
    draft: "Not exposed",
    endpoint: "Not exposed",
    connectedAt: null,
    publishedObjects: 0,
    subscribedObjects: 0,
    transportRttMs: "Not exposed",
  };

  async connect(endpoint: string, credential: string, draft: string): Promise<void> {
    if (draft !== "20") {
      throw new MoqTransportError(
        "draft_mismatch",
        `Local MOQT draft '${draft}' does not match the required draft '20'. No fallback was attempted.`,
      );
    }
    if (!("WebTransport" in globalThis)) {
      throw new MoqTransportError(
        "draft_unavailable",
        "WebTransport is not exposed by this browser, so MOQT draft 20 cannot start.",
      );
    }
    if (!credential) {
      throw new MoqTransportError(
        "relay_unavailable",
        "The room service did not mint a draft-20 relay credential. No connection was attempted.",
      );
    }

    this.stats = { ...this.stats, state: "connecting", draft, endpoint: redactEndpoint(endpoint) };
    try {
      this.client = await MOQtailClient.new({
        url: credentialUrl(endpoint, credential),
        enableDatagrams: false,
        callbacks: {
          onSessionTerminated: () => {
            this.stats = { ...this.stats, state: "closed" };
          },
        },
      });
      this.stats = { ...this.stats, state: "connected", connectedAt: Date.now() };
    } catch (error) {
      this.stats = { ...this.stats, state: "failed" };
      throw new MoqTransportError(
        "relay_unavailable",
        `MOQT draft 20 could not connect to '${redactEndpoint(endpoint)}': ${safeError(error, credential)}`,
      );
    }
  }

  async publish(track: TrackAddress, object: MediaObject): Promise<void> {
    const client = this.requireClient();
    const key = trackKey(track);
    let publication = this.publications.get(key);
    if (!publication) {
      const fullName = FullTrackName.tryNew(track.namespace, track.name);
      let controller: ReadableStreamDefaultController<MoqtObject> | undefined;
      const stream = new ReadableStream<MoqtObject>({ start: (value) => (controller = value) });
      if (!controller)
        throw new MoqTransportError("protocol_error", "The publication stream did not initialise.");
      client.addOrUpdateTrack({
        fullTrackName: fullName,
        trackSource: { live: new LiveTrackSource(stream) },
        publisherPriority: 0,
      });
      await client.publishNamespace(fullName.namespace);
      const result = await client.publish(fullName, true, this.nextAlias++);
      if (result instanceof RequestError) {
        throw new MoqTransportError("protocol_error", "The relay refused the track publication.");
      }
      publication = { address: track, fullName, controller };
      this.publications.set(key, publication);
    }

    publication.controller.enqueue(
      MoqtObject.newWithPayload(
        publication.fullName,
        new Location(object.groupId, object.objectId),
        0,
        ObjectForwardingPreference.Subgroup,
        0n,
        null,
        object.payload,
      ),
    );
    this.stats = { ...this.stats, publishedObjects: this.stats.publishedObjects + 1 };
  }

  async subscribe(
    track: TrackAddress,
    startPosition?: { groupId: number; objectId: number },
  ): Promise<ReadableStream<MediaObject>> {
    const client = this.requireClient();
    const fullName = FullTrackName.tryNew(track.namespace, track.name);
    const result = await client.subscribe({
      fullTrackName: fullName,
      priority: 0,
      groupOrder: GroupOrder.Original,
      forward: true,
      filterType: startPosition ? FilterType.AbsoluteStart : FilterType.LatestObject,
      ...(startPosition
        ? { startLocation: new Location(startPosition.groupId, startPosition.objectId) }
        : {}),
    });
    if (result instanceof RequestError) {
      throw new MoqTransportError("protocol_error", "The relay refused the track subscription.");
    }
    this.subscriptions.set(trackKey(track), result.requestId);
    const adapter = this;
    return result.stream.pipeThrough(
      new TransformStream<MoqtObject, MediaObject>({
        transform(object, controller) {
          if (!object.payload) return;
          adapter.stats = {
            ...adapter.stats,
            subscribedObjects: adapter.stats.subscribedObjects + 1,
          };
          controller.enqueue({
            groupId: Number(object.groupId),
            objectId: Number(object.objectId),
            payload: object.payload,
          });
        },
      }),
    );
  }

  async subscribeNamespace(namespace: string): Promise<void> {
    const client = this.requireClient();
    const result = await client.subscribeNamespace(Tuple.fromUtf8Path(namespace));
    if (result.response instanceof RequestError) {
      throw new MoqTransportError("protocol_error", `The relay refused namespace '${namespace}'.`);
    }
    this.namespaceCancels.set(namespace, result.cancel);
  }

  async unsubscribe(track: TrackAddress): Promise<void> {
    const client = this.requireClient();
    const key = trackKey(track);
    const requestId = this.subscriptions.get(key);
    if (requestId === undefined) return;
    await client.unsubscribe(requestId);
    this.subscriptions.delete(key);
  }

  sessionStats(): MoqSessionStats {
    return { ...this.stats };
  }

  async close(reason: string): Promise<void> {
    for (const cancel of this.namespaceCancels.values()) await cancel();
    this.namespaceCancels.clear();
    for (const publication of this.publications.values()) publication.controller.close();
    this.publications.clear();
    if (this.client) await this.client.disconnect(reason);
    this.client = null;
    this.subscriptions.clear();
    this.stats = { ...this.stats, state: "closed" };
  }

  private requireClient(): MOQtailClient {
    if (!this.client || this.stats.state !== "connected") {
      throw new MoqTransportError("protocol_error", "The MOQT session is not connected.");
    }
    return this.client;
  }
}

function trackKey(track: TrackAddress): string {
  return `${track.namespace}/${track.name}`;
}

function credentialUrl(endpoint: string, credential: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(credential)}`;
  return url.toString();
}

function redactEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname.split("/").slice(0, 2).join("/")}`;
}

function safeError(error: unknown, credential: string): string {
  if (!(error instanceof Error)) return "unknown transport failure";
  return error.message
    .replaceAll(credential, "[credential redacted]")
    .replaceAll(encodeURIComponent(credential), "[credential redacted]")
    .slice(0, 240);
}
