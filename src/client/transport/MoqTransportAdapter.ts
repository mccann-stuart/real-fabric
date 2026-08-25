import {
  AuthorizationToken,
  ClientSetup,
  FilterType,
  FullTrackName,
  GroupOrder,
  type KeyValuePair,
  LiveTrackSource,
  Location,
  MOQtailClient,
  MoqtObject,
  ObjectForwardingPreference,
  RequestError,
  ServerSetup,
  SetupParameter,
  SetupParameters,
  SUPPORTED_VERSIONS,
  Tuple,
} from "moqtail";
import type { MoqDraft } from "../../shared/contracts";

/**
 * The MOQT boundary (AGENTS.md). Every draft constant, wire version, ALPN
 * identifier and setup-parameter decision in the build lives in this file. The
 * room service, UI, telemetry and audio pipeline depend on the interface below
 * and never on `moqtail` directly. Draft 20 is the product target; until the
 * pinned library can frame it and an endpoint exists, the adapter refuses it by
 * name and never downgrades to draft 16.
 */

export interface TrackAddress {
  namespace: string;
  name: string;
}

export interface MediaObject {
  groupId: number;
  objectId: number;
  payload: Uint8Array;
}

/** How a draft identifies itself on the wire and in the ALPN/protocol offer. */
interface DraftProfile {
  /** The MOQT version token the relay must agree to. */
  wireVersion: string;
  /**
   * Offered as WebTransport subprotocols, which is where a browser expresses
   * the ALPN preference it is not allowed to set directly.
   */
  alpn: string[];
  /** Named in the mismatch error so the operator sees both sides. */
  note: string;
}

const DRAFT_REGISTRY: Record<MoqDraft, DraftProfile> = {
  "14": {
    wireVersion: "moqt-14",
    alpn: ["moqt-14"],
    note: "Cloudflare isolated relays still serve draft 14 alongside draft 16.",
  },
  "16": {
    wireVersion: "moqt-16",
    alpn: ["moqt-16", "moq-00"],
    note: "Available for adapter interoperability research only; not a permitted live-audio fallback.",
  },
  "18": {
    wireVersion: "moqt-18",
    alpn: ["moqt-18"],
    note: "Served by moq-rs. The pinned client library does not frame it.",
  },
  "20": {
    wireVersion: "moqt-20",
    alpn: ["moqt-20"],
    note: "No deployed relay endpoint (§2.1). Add the library version that frames it, then repoint configuration.",
  },
};

/**
 * The drafts the pinned library can actually frame, read from the library
 * rather than asserted here. Bumping `moqtail` moves this on its own, so the
 * build cannot claim a draft its wire encoder does not implement.
 */
const FRAMED_WIRE_VERSIONS: readonly string[] = SUPPORTED_VERSIONS;

/** Advertised in CLIENT_SETUP. Bounds how many requests the relay must track. */
const CLIENT_MAX_REQUEST_ID = 1024;
const CLIENT_MAX_AUTH_TOKEN_CACHE = 4096;
/** Private-use token type: this build's credentials are opaque bearer strings. */
const CREDENTIAL_TOKEN_TYPE = 0;

export function draftsFramedByClient(): MoqDraft[] {
  return (Object.keys(DRAFT_REGISTRY) as MoqDraft[]).filter((draft) =>
    FRAMED_WIRE_VERSIONS.includes(DRAFT_REGISTRY[draft].wireVersion),
  );
}

/** One CLIENT_SETUP or SERVER_SETUP parameter, rendered for the inspector. */
export interface SetupParameterRecord {
  name: string;
  value: string;
}

/**
 * §11.2 deliverable two: the negotiated handshake, recorded so the inspector
 * and the Gate 1 sheet can state which draft and endpoint actually carried the
 * session rather than which one was configured.
 */
export interface MoqNegotiation {
  requestedDraft: MoqDraft;
  negotiatedDraft: MoqDraft;
  wireVersion: string;
  alpnOffered: string[];
  endpointName: string;
  clientSetup: SetupParameterRecord[];
  serverSetup: SetupParameterRecord[];
  /** Requests the relay will accept. Zero would mean it grants nothing. */
  maxRequestId: number | null;
  negotiatedAt: number;
}

export interface MoqSessionStats {
  state: "idle" | "connecting" | "connected" | "closed" | "failed";
  draft: string;
  endpoint: string;
  connectedAt: number | null;
  publishedObjects: number;
  subscribedObjects: number;
  transportRttMs: number | "Not exposed";
  /** Null until CLIENT_SETUP and SERVER_SETUP have both been validated. */
  negotiation: MoqNegotiation | null;
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
    negotiation: null,
  };

  async connect(endpoint: string, credential: string, draft: string): Promise<void> {
    const profile = DRAFT_REGISTRY[draft as MoqDraft];
    if (!profile) {
      throw new MoqTransportError(
        "draft_unavailable",
        `MOQT draft '${draft}' is not a draft this build knows. No connection was attempted.`,
      );
    }
    // H1: the draft the library cannot frame is refused by name. There is no
    // branch here that tries a draft the caller did not ask for.
    if (!FRAMED_WIRE_VERSIONS.includes(profile.wireVersion)) {
      throw new MoqTransportError(
        "draft_mismatch",
        `The pinned MOQT client frames ${FRAMED_WIRE_VERSIONS.join(", ") || "no draft"}, and cannot frame draft ${draft} (${profile.wireVersion}). ${profile.note} No downgrade was attempted.`,
      );
    }
    if (!("WebTransport" in globalThis)) {
      throw new MoqTransportError(
        "draft_unavailable",
        `WebTransport is not exposed by this browser, so MOQT draft ${draft} cannot start.`,
      );
    }
    if (!credential) {
      throw new MoqTransportError(
        "relay_unavailable",
        `The room service minted no relay credential for draft ${draft}. No connection was attempted.`,
      );
    }

    const endpointName = describeEndpoint(endpoint);
    this.stats = {
      ...this.stats,
      state: "connecting",
      draft,
      endpoint: redactEndpoint(endpoint),
      negotiation: null,
    };

    // Captured during `MOQtailClient.new`, which performs the handshake before
    // it resolves, so these must be in scope before the call.
    let clientSetup: KeyValuePair[] | null = null;
    let serverSetupObserved = false;

    try {
      this.client = await MOQtailClient.new({
        url: endpoint,
        transportOptions: { protocols: [...profile.alpn] },
        // §8: the credential travels as a MOQT setup parameter, never in the
        // URL, so it cannot survive in a share link, a referrer or history.
        setupParameters: new SetupParameters()
          .addMaxRequestId(CLIENT_MAX_REQUEST_ID)
          .addMaxAuthTokenCacheSize(CLIENT_MAX_AUTH_TOKEN_CACHE)
          .addAuthorizationToken(
            AuthorizationToken.newUseValue(
              CREDENTIAL_TOKEN_TYPE,
              new TextEncoder().encode(credential),
            ),
          ),
        enableDatagrams: false,
        callbacks: {
          onMessageSent: (message) => {
            if (message instanceof ClientSetup) clientSetup = message.setupParameters;
          },
          onMessageReceived: (message) => {
            if (message instanceof ServerSetup) serverSetupObserved = true;
          },
          onSessionTerminated: () => {
            this.stats = { ...this.stats, state: "closed" };
          },
        },
      });
    } catch (error) {
      this.stats = { ...this.stats, state: "failed" };
      throw new MoqTransportError(
        "relay_unavailable",
        `MOQT draft ${draft} could not connect to '${endpointName}': ${safeError(error, credential)}`,
      );
    }

    try {
      this.stats = {
        ...this.stats,
        state: "connected",
        connectedAt: Date.now(),
        negotiation: this.validateHandshake({
          draft: draft as MoqDraft,
          profile,
          endpointName,
          clientSetup,
          serverSetupObserved,
          credential,
        }),
      };
    } catch (error) {
      // A relay that completes WebTransport but fails MOQT setup is a protocol
      // failure, not a working session. Close it rather than publish into it.
      await this.close("setup validation failed").catch(() => undefined);
      this.stats = { ...this.stats, state: "failed" };
      throw error;
    }
  }

  /**
   * §11.2 deliverable two: CLIENT_SETUP and SERVER_SETUP parameter validation.
   *
   * The relay must have sent SERVER_SETUP, and must have granted a request
   * budget — a zero budget means it accepted the session and will refuse every
   * subscription, which would otherwise present as silent dead air.
   */
  private validateHandshake(input: {
    draft: MoqDraft;
    profile: DraftProfile;
    endpointName: string;
    clientSetup: KeyValuePair[] | null;
    serverSetupObserved: boolean;
    credential: string;
  }): MoqNegotiation {
    const client = this.client;
    if (!client) {
      throw new MoqTransportError("protocol_error", "The MOQT session closed during setup.");
    }
    const serverSetup = client.serverSetup;
    if (!input.serverSetupObserved || !serverSetup) {
      throw new MoqTransportError(
        "protocol_error",
        `'${input.endpointName}' completed the WebTransport session but sent no SERVER_SETUP, so draft ${input.draft} was never agreed.`,
      );
    }

    const serverParameters = SetupParameters.fromKeyValuePairs(serverSetup.setupParameters);
    const maxRequestId = serverParameters.find((parameter) =>
      SetupParameter.isMaxRequestId(parameter),
    );
    const budget = maxRequestId ? Number(maxRequestId.maxId) : null;
    if (budget !== null && budget <= 0) {
      throw new MoqTransportError(
        "protocol_error",
        `'${input.endpointName}' granted a MAX_REQUEST_ID of ${budget}, so it would refuse every publication and subscription on draft ${input.draft}.`,
      );
    }

    return {
      requestedDraft: input.draft,
      // The library refuses a session whose version is not one it framed, so a
      // connected session is on the requested draft by construction.
      negotiatedDraft: input.draft,
      wireVersion: input.profile.wireVersion,
      alpnOffered: [...input.profile.alpn],
      endpointName: input.endpointName,
      clientSetup: describeParameters(input.clientSetup ?? [], input.credential),
      serverSetup: describeParameters(serverSetup.setupParameters, input.credential),
      maxRequestId: budget,
      negotiatedAt: Date.now(),
    };
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

/** The relay's operator-facing name, for the inspector and the Gate 1 record. */
function describeEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "an unparseable endpoint";
  }
}

function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname.split("/").slice(0, 2).join("/")}`;
  } catch {
    return "an unparseable endpoint";
  }
}

/**
 * AC-14: setup parameters are rendered for the inspector with the credential
 * removed. An authorisation token is reported as present, never as its value.
 */
function describeParameters(pairs: KeyValuePair[], credential: string): SetupParameterRecord[] {
  return SetupParameters.fromKeyValuePairs(pairs).map((parameter) => {
    if (SetupParameter.isMaxRequestId(parameter)) {
      return { name: "MAX_REQUEST_ID", value: String(parameter.maxId) };
    }
    if (SetupParameter.isMaxAuthTokenCacheSize(parameter)) {
      return { name: "MAX_AUTH_TOKEN_CACHE_SIZE", value: String(parameter.maxSize) };
    }
    if (SetupParameter.isPath(parameter)) {
      return { name: "PATH", value: redactCredential(parameter.moqtPath, credential) };
    }
    if (SetupParameter.isAuthorizationToken(parameter)) {
      return { name: "AUTHORIZATION_TOKEN", value: "present (redacted)" };
    }
    return { name: "unrecognised parameter", value: "present" };
  });
}

function safeError(error: unknown, credential: string): string {
  if (!(error instanceof Error)) return "unknown transport failure";
  return redactCredential(error.message, credential).slice(0, 240);
}

function redactCredential(value: string, credential: string): string {
  if (!credential) return value;
  return value
    .replaceAll(credential, "[credential redacted]")
    .replaceAll(encodeURIComponent(credential), "[credential redacted]");
}
