import {
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
  type Publish,
  PublishOk,
  ReasonPhrase,
  RequestError,
  RequestErrorCode,
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
 * and never on `moqtail` directly, so moving from draft 16 to draft 20 is an
 * entry in `DRAFT_REGISTRY` plus a configuration change.
 *
 * §11.2 milestone 1: the pinned client library frames draft 16, which is what
 * the operational Cloudflare isolated relays serve. A draft the library cannot
 * frame is refused by name — never downgraded to one it can.
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

/** How a draft identifies itself on the wire. */
interface DraftProfile {
  /** The MOQT version token the relay must agree to. */
  wireVersion: string;
  /** Named in the mismatch error so the operator sees both sides. */
  note: string;
}

const DRAFT_REGISTRY: Record<MoqDraft, DraftProfile> = {
  "14": {
    wireVersion: "moqt-14",
    note: "Cloudflare isolated relays still serve draft 14 alongside draft 16.",
  },
  "16": {
    wireVersion: "moqt-16",
    note: "Gate 1 target: operational on Cloudflare isolated relays and on moq-rs.",
  },
  "18": {
    wireVersion: "moqt-18",
    note: "Served by moq-rs. The pinned client library does not frame it.",
  },
  "20": {
    wireVersion: "moqt-20",
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
    readonly code:
      | "draft_mismatch"
      | "draft_unavailable"
      | "relay_configuration"
      | "relay_unavailable"
      | "request_refused"
      | "protocol_error",
    message: string,
    readonly request: MoqRequestRefusal | null = null,
  ) {
    super(message);
  }
}

export type MoqRequestOperation =
  | "track_publication"
  | "track_subscription"
  | "namespace_subscription";

/** Exact, sanitised relay refusal evidence retained for the inspector. */
export interface MoqRequestRefusal {
  operation: MoqRequestOperation;
  errorCode: number;
  reason: string;
}

export function isTrackNotFoundError(error: unknown): error is MoqTransportError {
  return (
    error instanceof MoqTransportError &&
    error.code === "request_refused" &&
    error.request?.operation === "track_subscription" &&
    error.request.errorCode === 16 &&
    /track not found/i.test(error.request.reason)
  );
}

export interface MoqTransportCallbacks {
  onUnexpectedTermination?: (error: MoqTransportError) => void;
  /** A subscribed namespace announced a newly available publication. */
  onNamespacePublished?: () => void;
  /** Whether a PUBLISH pushed through the room namespace should be accepted. */
  shouldAcceptPublishedTrack?: (track: TrackAddress) => boolean;
  /** A PUBLISH was accepted and is ready for the ordinary subscribe path. */
  onTrackPublished?: (track: TrackAddress) => void;
}

interface Publication {
  address: TrackAddress;
  fullName: FullTrackName;
  controller: ReadableStreamDefaultController<MoqtObject>;
}

interface PushedSubscription {
  requestId: bigint;
  stream: ReadableStream<MoqtObject>;
}

export class MoqTransportAdapter {
  private client: MOQtailClient | null = null;
  private publications = new Map<string, Publication>();
  private pendingPublications = new Map<string, Promise<Publication>>();
  private subscriptions = new Map<string, bigint>();
  private pushedSubscriptions = new Map<string, PushedSubscription>();
  private namespaceCancels = new Map<string, () => Promise<void>>();
  private nextAlias = 1n;
  private connectionGeneration = 0;
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

  constructor(private readonly callbacks: MoqTransportCallbacks = {}) {}

  async connect(endpoint: string, credential: string, draft: string): Promise<void> {
    const connectionGeneration = ++this.connectionGeneration;
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
    // MOQtail 0.12.1 appends every supported version to WebTransport's
    // `protocols` option. Refuse a future multi-version library until the
    // adapter can select exactly one version; otherwise the relay could choose
    // a draft the room did not request.
    if (FRAMED_WIRE_VERSIONS.length !== 1 || FRAMED_WIRE_VERSIONS[0] !== profile.wireVersion) {
      throw new MoqTransportError(
        "draft_mismatch",
        `The pinned MOQT client would offer ${FRAMED_WIRE_VERSIONS.join(", ") || "no draft"}; this session requires exactly ${profile.wireVersion}. No downgrade was attempted.`,
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
        "relay_configuration",
        `The room service supplied no relay credential for draft ${draft}. No connection was attempted.`,
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
        // Cloudflare's draft-16 relay authenticates the WebTransport session
        // with a provisioned token in the URL path. The URL exists only for
        // this constructor call and every error is redacted below.
        url: credentialUrl(endpoint, credential),
        // MOQtail appends its pinned SUPPORTED_VERSIONS itself. Supplying the
        // same version here produced ["moqt-16", "moqt-16"], which Chrome
        // rejects before a WebTransport handshake.
        setupParameters: new SetupParameters().addMaxRequestId(CLIENT_MAX_REQUEST_ID),
        enableDatagrams: false,
        callbacks: {
          onMessageSent: (message) => {
            if (message instanceof ClientSetup) clientSetup = message.setupParameters;
          },
          onMessageReceived: (message) => {
            if (message instanceof ServerSetup) serverSetupObserved = true;
          },
          onSessionTerminated: (reason) => {
            if (
              connectionGeneration !== this.connectionGeneration ||
              this.stats.state !== "connected"
            ) {
              return;
            }
            this.stats = { ...this.stats, state: "closed" };
            this.client = null;
            for (const publication of this.publications.values()) {
              try {
                publication.controller.close();
              } catch {
                // The terminated transport may already have closed the stream.
              }
            }
            this.publications.clear();
            this.pendingPublications.clear();
            this.subscriptions.clear();
            this.pushedSubscriptions.clear();
            this.namespaceCancels.clear();
            this.callbacks.onUnexpectedTermination?.(
              new MoqTransportError(
                "relay_unavailable",
                `The established MOQT session ended unexpectedly: ${terminationReason(reason, credential)}`,
              ),
            );
          },
        },
      });
      // Draft-specific namespace notifications stay inside the adapter.
      // RoomSession only learns that its ordinary subscription set should be
      // reconciled; it never depends on MOQtail's wire types.
      this.client.onPeerNamespace = () => this.callbacks.onNamespacePublished?.();
      // SUBSCRIBE_NAMESPACE defaults to requesting pushed publications as
      // well as namespace announcements. MOQtail exposes the incoming PUBLISH
      // to its caller but deliberately does not decide whether to accept it.
      // Make that decision here, inside the draft boundary, and retain the
      // stream for the existing subscribe() API.
      this.client.onPeerPublish = (message, stream) => {
        void this.handlePeerPublish(message, stream).catch((error: unknown) => {
          this.callbacks.onUnexpectedTermination?.(
            new MoqTransportError(
              "relay_unavailable",
              `The MOQT session could not answer a pushed publication: ${safeError(error, credential)}`,
            ),
          );
        });
      };
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
      alpnOffered: [...FRAMED_WIRE_VERSIONS],
      endpointName: input.endpointName,
      clientSetup: describeParameters(input.clientSetup ?? [], input.credential),
      serverSetup: describeParameters(serverSetup.setupParameters, input.credential),
      maxRequestId: budget,
      negotiatedAt: Date.now(),
    };
  }

  async publish(track: TrackAddress, object: MediaObject): Promise<void> {
    const key = trackKey(track);
    let publication = this.publications.get(key);
    if (!publication) {
      let pending = this.pendingPublications.get(key);
      if (!pending) {
        pending = this.openPublication(track);
        this.pendingPublications.set(key, pending);
      }
      try {
        publication = await pending;
      } finally {
        if (this.pendingPublications.get(key) === pending) this.pendingPublications.delete(key);
      }
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

  private async openPublication(track: TrackAddress): Promise<Publication> {
    const client = this.requireClient();
    const connectionGeneration = this.connectionGeneration;
    const fullName = FullTrackName.tryNew(track.namespace, track.name);
    let controller: ReadableStreamDefaultController<MoqtObject> | undefined;
    const stream = new ReadableStream<MoqtObject>({ start: (value) => (controller = value) });
    if (!controller) {
      throw new MoqTransportError("protocol_error", "The publication stream did not initialise.");
    }
    // MOQtail otherwise assigns the registered track a random alias, while
    // publish() advertises the caller-supplied alias. PublishPublication uses
    // the registered alias in subgroup headers, so both values must be the
    // same or the relay will stop every media stream after accepting PUBLISH.
    const trackAlias = this.nextAlias++;
    client.addOrUpdateTrack({
      fullTrackName: fullName,
      trackSource: { live: new LiveTrackSource(stream) },
      publisherPriority: 0,
      trackAlias,
    });
    // Cloudflare's draft-16 feature matrix exposes PUBLISH/PUBLISH_OK but not
    // PUBLISH_NAMESPACE. The track's full namespace is already carried by
    // PUBLISH, so sending the unsupported namespace request first can prevent
    // a credential that is otherwise allowed to publish from ever reaching
    // the supported request.
    const result = await client.publish(fullName, true, trackAlias);
    if (result instanceof RequestError) {
      throw requestRefusal("track_publication", "track publication", result);
    }
    if (connectionGeneration !== this.connectionGeneration || client !== this.client) {
      controller.close();
      throw new MoqTransportError(
        "relay_unavailable",
        "The MOQT session ended while the track publication was opening.",
      );
    }
    const publication = { address: track, fullName, controller };
    this.publications.set(trackKey(track), publication);
    return publication;
  }

  async subscribe(
    track: TrackAddress,
    startPosition?: { groupId: number; objectId: number },
  ): Promise<ReadableStream<MediaObject>> {
    const client = this.requireClient();
    const key = trackKey(track);
    const pushed = this.pushedSubscriptions.get(key);
    if (pushed) {
      this.pushedSubscriptions.delete(key);
      this.subscriptions.set(key, pushed.requestId);
      return this.mediaStream(pushed.stream);
    }
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
      // A namespace-pushed PUBLISH can cross this explicit SUBSCRIBE on the
      // wire. If it was accepted while this request was pending, use that
      // established subscription instead of surfacing a duplicate race.
      const concurrentPush = this.pushedSubscriptions.get(key);
      if (concurrentPush) {
        this.pushedSubscriptions.delete(key);
        this.subscriptions.set(key, concurrentPush.requestId);
        return this.mediaStream(concurrentPush.stream);
      }
      throw requestRefusal("track_subscription", "track subscription", result);
    }
    this.subscriptions.set(key, result.requestId);
    return this.mediaStream(result.stream);
  }

  private mediaStream(stream: ReadableStream<MoqtObject>): ReadableStream<MediaObject> {
    const adapter = this;
    return stream.pipeThrough(
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

  private async handlePeerPublish(
    message: Publish,
    stream: ReadableStream<MoqtObject>,
  ): Promise<void> {
    const client = this.requireClient();
    const track = trackAddress(message.fullTrackName);
    const key = trackKey(track);
    const accepted = this.callbacks.shouldAcceptPublishedTrack?.(track) ?? true;

    if (!accepted) {
      await client.controlStream.send(
        new RequestError(
          message.requestId,
          RequestErrorCode.Uninterested,
          0n,
          new ReasonPhrase("uninterested"),
        ),
      );
      await stream.cancel("publication not selected").catch(() => undefined);
      return;
    }

    if (this.subscriptions.has(key) || this.pushedSubscriptions.has(key)) {
      await client.controlStream.send(
        new RequestError(
          message.requestId,
          RequestErrorCode.DuplicateSubscription,
          0n,
          new ReasonPhrase("duplicate subscription"),
        ),
      );
      await stream.cancel("duplicate publication").catch(() => undefined);
      return;
    }

    this.pushedSubscriptions.set(key, { requestId: message.requestId, stream });
    try {
      await client.controlStream.send(new PublishOk(message.requestId, []));
    } catch (error) {
      this.pushedSubscriptions.delete(key);
      await stream.cancel("publication acknowledgement failed").catch(() => undefined);
      throw error;
    }
    this.callbacks.onTrackPublished?.(track);
  }

  async subscribeNamespace(namespace: string): Promise<void> {
    const client = this.requireClient();
    const result = await client.subscribeNamespace(Tuple.fromUtf8Path(namespace));
    if (result.response instanceof RequestError) {
      throw requestRefusal(
        "namespace_subscription",
        `namespace '${namespace}' subscription`,
        result.response,
      );
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
    // Mark an intentional close before disconnecting. MOQtail invokes the
    // termination callback during disconnect, and that must not start recovery.
    this.connectionGeneration += 1;
    this.stats = { ...this.stats, state: "closed" };
    for (const cancel of this.namespaceCancels.values()) await cancel();
    this.namespaceCancels.clear();
    for (const publication of this.publications.values()) publication.controller.close();
    this.publications.clear();
    this.pendingPublications.clear();
    for (const pushed of this.pushedSubscriptions.values()) {
      await pushed.stream.cancel("transport closed").catch(() => undefined);
    }
    this.pushedSubscriptions.clear();
    if (this.client) await this.client.disconnect(reason);
    this.client = null;
    this.subscriptions.clear();
  }

  private requireClient(): MOQtailClient {
    if (!this.client || this.stats.state !== "connected") {
      throw new MoqTransportError("protocol_error", "The MOQT session is not connected.");
    }
    return this.client;
  }
}

function requestErrorMessage(operation: string, error: RequestError): string {
  const reason = error.reasonPhrase.phrase.trim();
  return `The relay refused the ${operation} (code ${error.errorCode})${
    reason ? `: ${reason}` : "."
  }`;
}

function requestRefusal(
  operation: MoqRequestOperation,
  label: string,
  error: RequestError,
): MoqTransportError {
  return new MoqTransportError("request_refused", requestErrorMessage(label, error), {
    operation,
    errorCode: error.errorCode,
    reason: error.reasonPhrase.phrase.trim(),
  });
}

function trackKey(track: TrackAddress): string {
  return `${track.namespace}/${track.name}`;
}

function trackAddress(fullName: FullTrackName): TrackAddress {
  return {
    // MOQtail's diagnostic path includes a leading slash, while tryNew()
    // accepts and Real Fabric stores canonical slash-separated tuple fields.
    namespace: fullName.namespace.fields.map((field) => field.toUtf8()).join("/"),
    name: new TextDecoder("utf-8", { fatal: true }).decode(fullName.name),
  };
}

/**
 * Cloudflare draft-16 authentication is carried in the WebTransport URL path.
 * This URL is never returned to the UI, retained in state or written to logs.
 */
function credentialUrl(endpoint: string, credential: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(credential)}`;
  return url.toString();
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

function terminationReason(reason: unknown, credential: string): string {
  return reason === undefined
    ? "the peer closed the control stream without a reason"
    : safeError(reason, credential);
}

function redactCredential(value: string, credential: string): string {
  if (!credential) return value;
  return value
    .replaceAll(credential, "[credential redacted]")
    .replaceAll(encodeURIComponent(credential), "[credential redacted]");
}
