import type {
  AiPipelineState,
  DiscoveryMechanism,
  Participant,
  RoomEvent,
  RoomSnapshot,
  RoutingPreference,
} from "../../shared/contracts";
import { ROUTING_CHANGE_BUDGET_MS } from "../../shared/contracts";
import type { FailureCode } from "../../shared/failures";
import { type Measurement, measured, notExposed } from "../../shared/measurement";
import {
  audioTrack,
  fanOut,
  parseTrackName,
  participantNamespace,
  roomNamespace,
  trackKey,
} from "../../shared/tracks";
import { type AddressOutcome, AiDirector, type BargeInResult } from "../ai/AiDirector";
import { ScriptedResponder } from "../ai/ScriptedResponder";
import {
  fetchRoom,
  markActive,
  releaseFloor,
  requestFloor,
  roomEventsUrl,
  type StoredSession,
  setAiPipeline,
  updateRouting,
} from "../api";
import { CaptureController } from "../audio/CaptureController";
import { DegradationLadder, type LadderState } from "../audio/DegradationLadder";
import { DeviceWatcher } from "../audio/DeviceWatcher";
import {
  ForegroundAudioLifecycle,
  type ForegroundAudioLifecycleState,
} from "../audio/ForegroundAudioLifecycle";
import { encodeAudioObject } from "../audio/frame";
import { MixerGraph } from "../audio/MixerGraph";
import { PlaybackDeduplicator } from "../audio/PlaybackDeduplicator";
import { TrackPlayer } from "../audio/TrackPlayer";
import type { CapturePath } from "../audio/UniversalAudioCaptureAdapter";
import { SessionTelemetry } from "../telemetry/SessionTelemetry";
import {
  isTrackNotFoundError,
  type MoqNegotiation,
  MoqTransportAdapter,
  MoqTransportError,
} from "../transport/MoqTransportAdapter";
import { notRunProbe, type ProbeResult, probeRelayReachability } from "../transport/NetworkProbe";
import { ReconnectionPolicy } from "./ReconnectionPolicy";
import { type SessionEvent, SessionEventLog } from "./SessionEventLog";

/**
 * H1 and H12: the one place that owns the live session.
 *
 * It joins, holds the control-plane socket, attempts the MOQT session through
 * `MoqTransportAdapter` and nothing else, reconciles publications and
 * subscriptions against the routing matrix, and restores all of it after a
 * reconnect. There is no second transport to fall back to, by construction —
 * this class imports one adapter and no alternative.
 */

export type SessionPhase =
  | { name: "idle" }
  | { name: "awaiting_audio_start" }
  | { name: "connecting_transport" }
  | { name: "live" }
  | { name: "resume_required"; reason: string }
  | { name: "reconnecting"; attempt: number; nextAttemptInMs: number }
  /** Room and inspector usable, live audio blocked by a named §10 failure. */
  | { name: "blocked"; failure: FailureCode }
  /** FR5: needs the presenter's retry action. */
  | { name: "terminal"; failure: FailureCode }
  | { name: "left" };

export interface SessionMetrics {
  transportReadyMs: Measurement<number>;
  firstAudioMs: Measurement<number>;
  publishedTracks: Measurement<number>;
  subscribedTracks: Measurement<number>;
  worstBufferMs: Measurement<number>;
  outputLatencyMs: Measurement<number>;
  transportRttMs: Measurement<number>;
  lateDrops: Measurement<number>;
  cancelledDrops: Measurement<number>;
  /** §10.5: frames synthesised by packet loss concealment. */
  concealedFrames: Measurement<number>;
  comfortNoiseFrames: Measurement<number>;
  lastBargeInMs: Measurement<number>;
  lastRoutingChangeMs: Measurement<number>;
  reconnects: Measurement<number>;
  dtxEnabled: Measurement<boolean>;
  capturePath: Measurement<CapturePath>;
  /** MOQT object totals observed by the adapter in this browser session. */
  publishedObjects: Measurement<number>;
  subscribedObjects: Measurement<number>;
  objectsPerSecond: Measurement<number>;
  /** Mean complete demo audio object size, including the application header. */
  meanObjectBytes: Measurement<number>;
  lateDropRate: Measurement<number>;
  aggregateBufferMs: Measurement<number>;
  worstDriftPpm: Measurement<number>;
  activeDecoders: Measurement<number>;
  /** §11.3: audio inputs seen, and how many times they changed. */
  audioInputs: Measurement<number>;
  deviceChanges: Measurement<number>;
}

/**
 * §11.3 deliverable one: a browser with no usable microphone is a listener,
 * not an error. The mode is explicit so the UI never has to infer "can this
 * person speak" from a boolean that means something else on another screen.
 */
export type CaptureMode =
  | { name: "idle" }
  | { name: "resume_required"; reason: string }
  /** The automatic permission and capture request is in flight. */
  | { name: "starting" }
  /** Capture is live, but the relay has not accepted PUBLISH yet. */
  | { name: "opening_publication" }
  | { name: "publishing" }
  /** Listening and inspecting continue; nothing is published from here. */
  | { name: "listen_only"; failure: FailureCode; reason: string }
  /** A device appeared while in listen-only; the presenter is offered calibration. */
  | { name: "listen_only_device_available"; reason: string };

export type TrackSubscriptionStatus = "unsubscribed" | "subscribing" | "waiting" | "subscribed";

/** Per-listener transport state shown on each remote participant card. */
export interface TrackSubscriptionState {
  participantId: string;
  intent: boolean;
  status: TrackSubscriptionStatus;
  detail: string;
}

export interface SessionState {
  phase: SessionPhase;
  room: RoomSnapshot | null;
  /** Distinct active failures, most recent first. Never a single generic one. */
  failures: FailureCode[];
  degradation: LadderState;
  publishing: boolean;
  muted: boolean;
  capture: CaptureMode;
  audioLifecycle: ForegroundAudioLifecycleState;
  /** Subscriptions the relay accepted, used by the live inspector graph. */
  subscribedParticipantIds: string[];
  subscriptions: TrackSubscriptionState[];
  speaking: boolean;
  micLevel: number;
  metrics: SessionMetrics;
  /** §11.2: the negotiated draft and endpoint, once setup has been validated. */
  negotiation: MoqNegotiation | null;
  /** §11.2: background HTTP/3 reachability, used to tell UDP filtering apart. */
  network: ProbeResult;
  events: SessionEvent[];
}

export interface RoomSessionOptions {
  session: StoredSession;
  /** Presenter simulation: labelled, and never a substitute for transport. */
  presenterMode: boolean;
  now?: () => number;
}

const LADDER_INTERVAL_MS = 2_000;
const DRAIN_INTERVAL_MS = 20;
const CONTROL_RETRY_BASE_MS = 250;
const CONTROL_RETRY_MAX_MS = 5_000;
const STABLE_TRANSPORT_MS = 5_000;
export const SUBSCRIPTION_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 5_000, 5_000] as const;

interface SubscriptionRetry {
  attempt: number;
  nextAttemptAt: number | null;
  reason: string;
  publisherNotReady: boolean;
}

export function subscriptionRetryDelay(attempt: number): number | null {
  return SUBSCRIPTION_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

/** Only an indeterminate relay outage benefits from the bounded retry policy. */
export function isRetryableTransportFailure(failure: FailureCode): boolean {
  return failure === "relay_failed";
}

export class RoomSession {
  readonly director = new AiDirector();
  readonly scripted = new ScriptedResponder();
  readonly telemetry = new SessionTelemetry();

  private readonly log: SessionEventLog;
  private readonly transport = new MoqTransportAdapter({
    onUnexpectedTermination: (error) => this.onTransportTerminated(error),
    onNamespacePublished: () => {
      // A human may publish after our first SUBSCRIBE was refused. Reconcile
      // on the protocol's publication announcement instead of waiting for an
      // unrelated membership or routing event.
      this.retryWaitingSubscriptionsNow();
    },
    shouldAcceptPublishedTrack: (track) => this.shouldAcceptPublishedTrack(track),
    onTrackPublished: () => {
      // A pushed PUBLISH is already relay-accepted by the adapter. Reconcile
      // immediately so the retained stream enters the ordinary player path.
      this.retryWaitingSubscriptionsNow();
    },
  });
  private mixer: MixerGraph;
  private readonly capture = new CaptureController();
  private readonly playbackDeduplicator = new PlaybackDeduplicator();
  private readonly lifecycle: ForegroundAudioLifecycle;
  private readonly ladder = new DegradationLadder();
  private readonly reconnection = new ReconnectionPolicy();
  private readonly players = new Map<string, TrackPlayer>();
  private readonly subscriptionIntent = new Map<string, boolean>();
  private readonly subscriptionRetries = new Map<string, SubscriptionRetry>();
  private readonly subscriptionsOpening = new Set<string>();
  private readonly now: () => number;

  private readonly devices: DeviceWatcher;

  private listeners = new Set<(state: SessionState) => void>();
  private socket: WebSocket | null = null;
  private phase: SessionPhase = { name: "idle" };
  private room: RoomSnapshot | null = null;
  private observedDiscovery: DiscoveryMechanism | null = null;
  private captureMode: CaptureMode = { name: "idle" };
  private network: ProbeResult = notRunProbe("The relay reachability probe has not started.");
  private failures: FailureCode[] = [];
  private degradation: LadderState = {
    step: 0,
    nominalBufferMs: 60,
    releasedDecoders: [],
    unsubscribed: [],
    announcement: null,
  };
  private publishing = false;
  private muted = false;
  private publishingStart: Promise<void> | null = null;
  private audioStart: Promise<void> | null = null;
  private audioGeneration = 0;
  private lifecycleState: ForegroundAudioLifecycleState = {
    audioSession: "not_exposed",
    wakeLock: "not_exposed",
    wakeLockReason: "Screen Wake Lock is not exposed by this browser.",
  };
  private sequence = 0;
  private currentGroup = 0;
  private groupStartedAt = 0;
  private startedAt: number | null = null;
  private transportReadyAt: number | null = null;
  private firstAudioAt: number | null = null;
  private lastBargeIn: BargeInResult | null = null;
  private lastRoutingChangeMs: number | null = null;
  private reconnects = 0;
  private ladderTimer: ReturnType<typeof setInterval> | null = null;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private controlRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private controlReconnectAttempt = 0;
  private publicationFailureHandling = false;
  private closed = false;

  constructor(private readonly options: RoomSessionOptions) {
    this.now = options.now ?? Date.now;
    this.log = new SessionEventLog(
      `real-fabric:events:${options.session.code}:${options.session.participantId}`,
    );
    for (const [participantId, enabled] of restoreSubscriptionIntent(options.session)) {
      this.subscriptionIntent.set(participantId, enabled);
    }
    this.devices = new DeviceWatcher({
      onChange: (transition) => this.onDeviceChange(transition),
    });
    this.mixer = this.createMixer();
    this.lifecycle = new ForegroundAudioLifecycle({
      onInterrupted: (reason) => void this.interruptAudio(reason),
      onChange: (state) => {
        this.lifecycleState = state;
        this.emit();
      },
    });
  }

  /**
   * §11.3 deliverable two: a headset plugged in after a listen-only join is
   * offered calibration instead of requiring a reload, and a device removed
   * mid-session is named rather than presenting as a dead microphone.
   */
  private onDeviceChange(
    transition: "first_input_appeared" | "input_added" | "input_removed" | "none",
  ): void {
    if (transition === "none") return;
    this.log.record("device", `Audio input devices changed: ${transition.replaceAll("_", " ")}`);

    const listenOnly = this.captureMode.name === "listen_only";
    if (transition !== "input_removed" && listenOnly) {
      const previous = this.captureMode;
      if (previous.name === "listen_only" && previous.failure === "microphone_no_device") {
        // The reason for listen-only has gone away. Clear it and offer capture.
        this.clearFailure("microphone_no_device");
        this.captureMode = {
          name: "listen_only_device_available",
          reason:
            "An audio input device appeared. Run the microphone test to calibrate and start publishing.",
        };
      }
    }
    if (transition === "input_removed" && this.publishing) {
      this.raise("microphone_no_device");
    }
    this.emit();
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /**
   * Applies a room snapshot and opens membership/control state. Capture,
   * playout and MOQT deliberately wait for an in-room Start audio action so
   * Safari can associate them with fresh user activation.
   */
  async start(room: RoomSnapshot): Promise<void> {
    this.startedAt = this.now();
    this.applyRoom(room);
    this.openControlChannel();
    this.ladderTimer = setInterval(() => this.tickLadder(), LADDER_INTERVAL_MS);
    // §11.3: watch for hot-plugged devices from the moment the room opens, not
    // only once capture has been attempted.
    void this.devices.start();
    // §11.2: the reachability probe runs alongside the session rather than
    // before it, so it never delays the join, and its answer is ready when a
    // transport failure needs classifying.
    void this.runNetworkProbe(room);
    this.setPhase({ name: "awaiting_audio_start" });
  }

  /**
   * Starts or resumes the entire audio branch. Call this directly from a user
   * action: Audio Session, wake lock, AudioContext and getUserMedia are all
   * initiated before the first await.
   */
  async startAudio(): Promise<void> {
    if (this.closed || this.phase.name === "left") return;
    if (this.phase.name === "live") {
      await this.startPublishing();
      return;
    }
    if (this.audioStart) return this.audioStart;

    const generation = ++this.audioGeneration;
    // Move out of the idle phase synchronously so a visibility or Audio
    // Session interruption can cancel an activation that is still awaiting
    // identity or network work.
    this.setPhase({ name: "connecting_transport" });
    const lifecycleActivation = this.lifecycle.activate();
    const publishing = this.startPublishing(generation);
    const attempt = this.startAudioOnce(generation, lifecycleActivation, publishing);
    this.audioStart = attempt;
    try {
      await attempt;
    } finally {
      if (this.audioStart === attempt) this.audioStart = null;
    }
  }

  private async startAudioOnce(
    generation: number,
    lifecycleActivation: Promise<void>,
    publishing: Promise<void>,
  ): Promise<void> {
    try {
      // Authenticated activity confirms that the retained participant identity
      // is still valid before a resumed transport publishes into the room.
      await markActive(this.options.session, this.options.session.participantId);
      if (generation !== this.audioGeneration || this.closed) return;
      this.applyRoom(await fetchRoom(this.options.session.code));
      if (generation !== this.audioGeneration || this.closed) return;
      await this.openTransport(generation);
    } catch (error) {
      if (generation === this.audioGeneration && !this.closed) {
        const reason =
          error instanceof Error
            ? `The participant identity could not be revalidated: ${error.message}`
            : "The participant identity could not be revalidated.";
        this.raise("participant_disconnected");
        await this.interruptAudio(reason);
      }
    } finally {
      await Promise.allSettled([lifecycleActivation, publishing]);
    }
  }

  /**
   * Foreground-only contract: hiding or interrupting Safari tears down every
   * audio resource and leaves room/control state visible. Returning never
   * restarts the microphone without a new Resume audio action.
   */
  async interruptAudio(reason: string): Promise<void> {
    if (
      this.closed ||
      this.phase.name === "left" ||
      this.phase.name === "awaiting_audio_start" ||
      this.phase.name === "resume_required"
    ) {
      return;
    }

    this.audioGeneration += 1;
    this.publishing = false;
    this.captureMode = { name: "resume_required", reason };
    this.setPhase({ name: "resume_required", reason });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.retryTimer = null;
    this.drainTimer = null;
    this.clearSubscriptionRetryTimer();
    this.subscriptionsOpening.clear();
    this.subscriptionRetries.clear();
    for (const player of this.players.values()) player.close();
    this.players.clear();
    await Promise.allSettled([
      this.capture.stop(),
      this.transport.close("foreground audio interrupted"),
      this.mixer.close(),
      this.lifecycle.releaseWakeLock(reason),
    ]);
    this.mixer = this.createMixer();
    this.log.record("failure", `${reason} Audio stopped; tap Resume audio to reconnect.`);
    this.emit();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.capture.setMuted(muted);
    this.log.record(
      "device",
      muted ? "Microphone muted by participant." : "Microphone unmuted by participant.",
    );
    this.emit();
  }

  private createMixer(): MixerGraph {
    return new MixerGraph({
      onSuspended: () =>
        void this.interruptAudio("The browser suspended the audio output context."),
    });
  }

  private async runNetworkProbe(room: RoomSnapshot): Promise<void> {
    const relayEndpoint = room.transport.endpoint || null;
    this.network = await probeRelayReachability({ relayEndpoint });
    this.log.record("connect", `HTTP/3 reachability: ${this.network.detail}`);
    this.emit();
  }

  /**
   * H1: the only transport path. When the room service reports the draft or
   * relay unavailable, this records that specific failure and stops. It never
   * tries a different draft or a different transport.
   */
  private async openTransport(generation = this.audioGeneration): Promise<void> {
    const room = this.room;
    if (!room) return;

    if (room.transport.availability !== "available") {
      const failure = room.transport.failure ?? "draft_endpoint_missing";
      this.raise(failure);
      this.setPhase({ name: "blocked", failure });
      this.log.record("failure", room.transport.reason);
      return;
    }

    this.setPhase({ name: "connecting_transport" });
    const credential = this.relayCredential;
    if (!credential) {
      this.raise("relay_auth_unavailable");
      this.setPhase({ name: "blocked", failure: "relay_auth_unavailable" });
      this.log.record(
        "failure",
        "The room service supplied no provisioned relay credential, so no MOQT session was attempted.",
      );
      return;
    }

    try {
      await this.transport.connect(room.transport.endpoint, credential, room.transport.draft);
      if (generation !== this.audioGeneration || this.closed) {
        await this.transport.close("stale audio activation");
        return;
      }
      this.transportReadyAt = this.now();
      const negotiation = this.transport.sessionStats().negotiation;
      // §11.2 deliverable two: the negotiated draft and endpoint are recorded
      // from the handshake, not restated from configuration.
      this.log.record(
        "connect",
        negotiation
          ? `MOQT draft ${negotiation.negotiatedDraft} (${negotiation.wireVersion}) established with ${negotiation.endpointName}; SERVER_SETUP validated`
          : `MOQT draft ${room.transport.draft} session established`,
      );
      this.telemetry.record({ type: "transport_ready", value: this.transportReadyMsRaw() ?? 0 });
      await this.discover(room);
      this.setPhase({ name: "live" });
      await this.reconcileSubscriptions();
      this.startDraining();
    } catch (error) {
      await this.handleTransportFailure(error);
    }
  }

  /** FR7: try the MoQ primitive, and say which mechanism actually carried it. */
  private async discover(room: RoomSnapshot): Promise<void> {
    if (room.transport.discovery === "control_channel") {
      this.recordDiscovery("control_channel");
      this.raise("namespace_discovery_unavailable");
      this.log.record(
        "subscribe",
        "Discovery is using the room service control channel, not SUBSCRIBE_NAMESPACE.",
      );
      return;
    }
    try {
      await this.transport.subscribeNamespace(roomNamespace(room.code));
      this.recordDiscovery("subscribe_namespace");
      this.log.record("subscribe", `SUBSCRIBE_NAMESPACE on ${roomNamespace(room.code)}`);
    } catch (error) {
      this.recordDiscovery("control_channel");
      this.raise("namespace_discovery_unavailable");
      this.log.record(
        "subscribe",
        `SUBSCRIBE_NAMESPACE was refused; falling back to control-channel discovery${
          error instanceof Error ? `: ${error.message}` : "."
        }`,
      );
    }
  }

  /** Gate 1 output four is the request result observed on this live session. */
  private recordDiscovery(discovery: DiscoveryMechanism): void {
    this.observedDiscovery = discovery;
    if (!this.room) return;
    this.room = {
      ...this.room,
      transport: { ...this.room.transport, discovery },
    };
  }

  private async handleTransportFailure(error: unknown): Promise<void> {
    const failure = this.classifyTransportFailure(error);
    this.raise(failure);
    this.log.record("failure", error instanceof Error ? error.message : "Transport failed.");

    // A deterministic configuration, capability or protocol refusal does not
    // improve with backoff. Only an indeterminate relay outage is retryable.
    if (!isRetryableTransportFailure(failure)) {
      this.setPhase({ name: "blocked", failure });
      if (failure === "udp_blocked" || failure === "transport_reliable_only") {
        this.log.record("failure", this.network.remediation ?? "Switch to the documented hotspot.");
      }
      return;
    }

    const decision = this.reconnection.next(this.now());
    if (!decision.retry) {
      this.setPhase({ name: "terminal", failure });
      this.log.record(
        "reconnect",
        `Reconnection abandoned after ${Math.round(decision.elapsedMs / 1_000)} seconds. A retry action is required.`,
      );
      return;
    }
    this.reconnects += 1;
    this.setPhase({
      name: "reconnecting",
      attempt: decision.attempt,
      nextAttemptInMs: decision.delayMs,
    });
    this.log.record("reconnect", `Attempt ${decision.attempt} in ${decision.delayMs} ms`);
    this.telemetry.record({ type: "reconnect_attempt", value: decision.attempt });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.closed) void this.openTransport();
    }, decision.delayMs);
  }

  private onTransportTerminated(error: MoqTransportError): void {
    if (this.closed || this.phase.name !== "live") return;

    if (
      this.transportReadyAt !== null &&
      this.now() - this.transportReadyAt >= STABLE_TRANSPORT_MS
    ) {
      this.reconnection.reset();
    }

    // A dead subscription belongs to the dead MOQT session. Clearing these
    // lets the normal reconciliation path recreate each track idempotently
    // after the bounded reconnect succeeds.
    for (const player of this.players.values()) player.close();
    this.players.clear();
    this.subscriptionsOpening.clear();
    this.subscriptionRetries.clear();
    this.clearSubscriptionRetryTimer();
    if (this.publishing || this.captureMode.name === "opening_publication") {
      this.publishing = false;
      this.captureMode = { name: "opening_publication" };
    }
    void this.handleTransportFailure(error);
  }

  /**
   * §10 rows are distinct, so a transport failure is classified rather than
   * collapsed into one. The background probe is what separates "this network
   * filters UDP" from "this relay is down" — from inside a failed connection
   * attempt the two are indistinguishable, and their recovery advice differs.
   */
  private classifyTransportFailure(error: unknown): FailureCode {
    if (!(error instanceof MoqTransportError)) return "relay_failed";
    switch (error.code) {
      case "draft_mismatch":
        return "draft_mismatch";
      case "draft_unavailable":
        return "transport_unsupported";
      case "relay_configuration":
        return "relay_auth_unavailable";
      case "reliable_transport":
        return "transport_reliable_only";
      case "protocol_error":
        return "relay_protocol_error";
      case "request_refused":
        return "relay_request_refused";
      default:
        return this.network.state === "udp_blocked" ? "udp_blocked" : "relay_failed";
    }
  }

  /** FR5: the presenter's explicit retry after a terminal failure. */
  async retry(): Promise<void> {
    this.reconnection.reset();
    this.failures = [];
    await this.openTransport();
  }

  /**
   * Starts publication from the explicit Start/Resume action, or retries only
   * the microphone after a permission/device failure. It never substitutes a
   * transport when capture fails.
   */
  async startPublishing(generation = this.audioGeneration): Promise<void> {
    if (this.publishing) return;
    if (this.captureMode.name === "opening_publication") return;
    if (this.publishingStart) return this.publishingStart;

    // A rejected PUBLISH leaves the MOQT session itself usable. Retrying the
    // microphone re-arms only publication on that same negotiated session.
    if (
      this.phase.name === "blocked" &&
      this.phase.failure === "relay_request_refused" &&
      this.transport.sessionStats().state === "connected"
    ) {
      this.clearFailure("relay_request_refused");
      this.setPhase({ name: "live" });
    }

    this.captureMode = { name: "starting" };
    this.emit();
    const attempt = this.startPublishingOnce(generation);
    this.publishingStart = attempt;
    try {
      await attempt;
    } finally {
      if (this.publishingStart === attempt) this.publishingStart = null;
    }
  }

  private async startPublishingOnce(generation: number): Promise<void> {
    if (this.closed) return;
    const mixerStart = this.mixer.start();
    // Invoked before the first await so Safari sees getUserMedia in the same
    // transient user activation as the Start/Resume button.
    const captureStart = this.capture.start({
      onEncodedFrame: (frame) => this.publishFrame(frame),
      onOnset: () => void this.onHumanOnset(),
      onRelease: () => this.emit(),
      onError: (error) => {
        this.raise("audio_behind");
        this.log.record("failure", error.message);
      },
    });
    const [mixerResult, captureResult] = await Promise.allSettled([mixerStart, captureStart]);

    if (generation !== this.audioGeneration || this.closed) {
      await this.capture.stop();
      return;
    }

    if (mixerResult.status === "rejected") {
      await this.capture.stop();
      const error = mixerResult.reason;
      this.enterListenOnly(
        "transport_unsupported",
        error instanceof Error ? error.message : "The audio output graph could not start.",
      );
      this.emit();
      return;
    }

    if (this.closed) return;

    if (captureResult.status === "fulfilled") {
      this.capture.setMuted(this.muted);
      this.mixer.resume();
      // Capture and accepted relay publication are deliberately separate.
      // The first encoded frame opens PUBLISH; only its PUBLISH_OK changes the
      // state to publishing and creates the inspector event.
      if (!this.publishing) this.captureMode = { name: "opening_publication" };
    } else {
      const error = captureResult.reason;
      const name = error instanceof DOMException ? error.name : "";
      const failure: FailureCode =
        name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "microphone_no_device"
          : name === "NotAllowedError" || name === "SecurityError"
            ? "microphone_denied"
            : "transport_unsupported";
      this.enterListenOnly(
        failure,
        error instanceof Error ? error.message : "Microphone capture failed.",
      );
    }
    this.emit();
  }

  private enterListenOnly(failure: FailureCode, reason: string): void {
    this.publishing = false;
    this.captureMode = { name: "listen_only", failure, reason };
    this.raise(failure);
    this.log.record(
      "failure",
      `${reason} Continuing in listen-only mode; subscriptions and the inspector are unaffected.`,
    );
  }

  /** True while this browser can hear the room but publishes nothing. */
  get listenOnly(): boolean {
    return (
      this.captureMode.name === "listen_only" ||
      this.captureMode.name === "listen_only_device_available"
    );
  }

  private publishFrame(frame: EncodedAudioChunk): void {
    const room = this.room;
    if (!room) return;

    // §6.3: one group is one second of audio, giving frequent recovery points
    // and a natural cancellation unit for barge-in.
    const now = this.now();
    if (this.groupStartedAt === 0 || now - this.groupStartedAt >= 1_000) {
      this.currentGroup += 1;
      this.groupStartedAt = now;
    }

    const payload = new Uint8Array(frame.byteLength);
    frame.copyTo(payload);
    const object = encodeAudioObject(
      {
        participantHash: hashParticipant(this.options.session.participantId),
        mediaTimestamp: Math.round(frame.timestamp / 1_000),
        sequence: this.sequence++,
      },
      payload,
    );

    if (this.phase.name !== "live") return;
    void this.transport
      .publish(audioTrack(room.code, this.options.session.participantId), {
        groupId: this.currentGroup,
        objectId: this.sequence,
        payload: object,
      })
      .then(() => this.onPublicationAccepted())
      .catch((error: unknown) => {
        // A failed publication is a session failure, not a per-frame warning.
        // The first rejection moves the phase out of live, which suppresses
        // the other frames already queued behind the same publication.
        if (this.phase.name !== "live") return;
        void this.handlePublicationFailure(error);
      });
  }

  private onPublicationAccepted(): void {
    if (this.closed || this.publishing) return;
    this.publishing = true;
    this.captureMode = { name: "publishing" };
    this.log.record("publish", `audio/${this.options.session.participantId}`);
    this.telemetry.record({ type: "publication_opened" });
    this.emit();
  }

  private async handlePublicationFailure(error: unknown): Promise<void> {
    if (this.publicationFailureHandling || this.closed) return;
    this.publicationFailureHandling = true;
    try {
      this.publishing = false;
      await this.capture.stop();
      const failure = this.classifyTransportFailure(error);
      const reason = error instanceof Error ? error.message : "Track publication failed.";
      this.captureMode = { name: "listen_only", failure, reason };
      await this.handleTransportFailure(error);
    } finally {
      this.publicationFailureHandling = false;
      this.emit();
    }
  }

  /**
   * H6: a human onset cancels the addressed AI's turn, closes its group and
   * publishes a cancellation marker; receivers discard the rest of that group.
   */
  private async onHumanOnset(): Promise<void> {
    const onsetAt = this.now();
    const result = this.director.bargeIn(onsetAt);
    if (!result) {
      this.emit();
      return;
    }

    let discarded = 0;
    for (const player of this.players.values()) {
      if (player.participantId !== result.aiId) continue;
      discarded += player.cancelGroup(result.groupId);
    }
    this.lastBargeIn = result;
    this.log.record(
      "barge_in",
      `Stopped in ${result.latencyMs} ms (budget ${result.withinBudget ? "met" : "missed"}); ${discarded} queued objects discarded`,
      { subject: result.aiId },
    );
    this.telemetry.record({
      type: "barge_in",
      participantId: result.aiId,
      value: result.latencyMs,
    });
    await this.setPipeline(result.aiId, "interrupted");
    this.emit();
  }

  /** H5: the presenter addressing one AI. Nothing else starts a turn. */
  async address(aiId: string): Promise<AddressOutcome> {
    const outcome = this.director.address(aiId, this.options.session.participantId, "human");
    if (outcome.result === "queued") {
      // FR4: the second addressed AI shows Thinking and waits its turn.
      await requestFloor(this.options.session, aiId).catch(() => undefined);
      await this.setPipeline(aiId, "thinking");
      this.log.record(
        "simulation",
        `Queued behind the speaking AI at position ${outcome.position}`,
        {
          subject: aiId,
          simulated: true,
        },
      );
    }
    if (outcome.result === "speaking") {
      await requestFloor(this.options.session, aiId).catch(() => undefined);
      await this.setPipeline(aiId, "speaking");
      this.log.record("simulation", "Addressed directly; scripted turn started", {
        subject: aiId,
        simulated: true,
      });
    }
    if (outcome.result === "refused") {
      this.log.record("simulation", `Address refused: ${outcome.reason}`, {
        subject: aiId,
        simulated: true,
      });
      if (outcome.reason === "turn_cap") this.raise("ai_loop_capped");
    }
    this.emit();
    return outcome;
  }

  async endTurn(aiId: string): Promise<void> {
    const promoted = this.director.endTurn(aiId);
    await releaseFloor(this.options.session, aiId).catch(() => undefined);
    await this.setPipeline(aiId, "listening");
    if (promoted) await this.setPipeline(promoted.aiId, "speaking");
    this.emit();
  }

  /**
   * H9 and FR8: a routing change is a subscription change, not a filter, and it
   * must take effect within 500 ms and show in the inspector.
   */
  async changeRouting(aiId: string, hearsMe: boolean, iHearIt: boolean): Promise<void> {
    const requestedAt = this.now();
    const previous = this.routingFor(aiId);
    const room = await updateRouting(this.options.session, aiId, hearsMe, iHearIt);
    this.applyRoom(room);
    await this.reconcileSubscriptions();
    const elapsed = this.now() - requestedAt;
    this.lastRoutingChangeMs = elapsed;

    if (previous?.hearsMe && !hearsMe) {
      // The AI stops receiving this human from now on, which is what makes
      // "it cannot answer" true rather than performed.
      this.scripted.resetHeard(aiId, this.options.session.participantId);
    }
    this.log.record(
      "routing_change",
      `hears me ${hearsMe ? "on" : "off"}, I hear it ${iHearIt ? "on" : "off"} in ${elapsed} ms${
        elapsed > ROUTING_CHANGE_BUDGET_MS ? " (over the 500 ms budget)" : ""
      }`,
      { subject: aiId },
    );
    this.telemetry.record({ type: "routing_change", participantId: aiId, value: elapsed });
    this.emit();
  }

  /**
   * The subscription graph, rebuilt from the routing matrix. Idempotent, so
   * FR5 restoration after a reconnect is the same code path as a routing
   * change.
   */
  private async reconcileSubscriptions(): Promise<void> {
    const room = this.room;
    if (!room || this.phase.name !== "live") return;
    const wanted = new Set(this.subscribableParticipants().map((participant) => participant.id));
    for (const participantId of this.subscriptionRetries.keys()) {
      if (!wanted.has(participantId)) this.subscriptionRetries.delete(participantId);
    }

    for (const [participantId, player] of this.players) {
      if (wanted.has(participantId)) continue;
      await this.unsubscribeParticipant(participantId, player);
    }

    for (const participantId of wanted) {
      if (this.players.has(participantId) || this.subscriptionsOpening.has(participantId)) continue;
      const retry = this.subscriptionRetries.get(participantId);
      if (retry && (retry.nextAttemptAt === null || retry.nextAttemptAt > this.now())) continue;
      const track = audioTrack(room.code, participantId);
      const player = new TrackPlayer(
        participantId,
        trackKey(track),
        this.mixer,
        {
          onFirstObject: (trackId) => {
            if (this.firstAudioAt === null) this.firstAudioAt = this.now();
            this.log.record("first_object", trackId, { subject: participantId });
            void markActive(this.options.session, participantId).catch(() => undefined);
          },
          onDriftCorrection: (correction) =>
            this.log.record(
              "drift",
              `ratio ${correction.ratio.toFixed(5)} at ${Math.round(correction.skewPpm)} ppm`,
              { subject: participantId },
            ),
          onDriftBeyondRange: () => {
            this.raise("drift_uncorrectable");
            // §11.3: scheduled, not immediate. Rebuilding mid-word is audible.
            this.log.record("drift", "Beyond correction range; buffer rebuild queued for a pause", {
              subject: participantId,
            });
          },
          onConcealment: (_trackId, frames, kind) => {
            // §10.5: concealment is a quality warning, never a silent repair.
            this.raise("audio_behind");
            this.log.record(
              "concealment",
              kind === "comfort_noise"
                ? `${frames} frames missing; sustained loss, emitting comfort noise`
                : `${frames} frames missing; concealed by pitch repetition`,
              { subject: participantId },
            );
          },
          onError: (_trackId, error) => {
            this.raise("audio_behind");
            this.log.record("failure", error.message, { subject: participantId });
          },
        },
        this.playbackDeduplicator,
      );
      this.subscriptionsOpening.add(participantId);
      this.log.record("subscribe", `audio/${participantId}`, { subject: participantId });
      this.emit();

      try {
        const stream = await this.transport.subscribe(track);
        this.subscriptionsOpening.delete(participantId);
        this.subscriptionRetries.delete(participantId);
        if (
          !this.subscribableParticipants().some((participant) => participant.id === participantId)
        ) {
          player.close();
          await this.transport.unsubscribe(track).catch(() => undefined);
          this.log.record("unsubscribe", `audio/${participantId}`, { subject: participantId });
          continue;
        }
        this.players.set(participantId, player);
        void this.consume(participantId, player, stream);
      } catch (error) {
        this.subscriptionsOpening.delete(participantId);
        player.close();
        const reason = error instanceof Error ? error.message : "Subscribe failed.";
        if (isTrackNotFoundError(error)) {
          const attempt = (retry?.attempt ?? 0) + 1;
          const delayMs = subscriptionRetryDelay(attempt);
          this.subscriptionRetries.set(participantId, {
            attempt,
            nextAttemptAt: delayMs === null ? null : this.now() + delayMs,
            reason,
            publisherNotReady: true,
          });
          this.log.record(
            "subscribe",
            delayMs === null
              ? `${reason} Automatic retries stopped after ${attempt} attempts; use the track control to retry.`
              : `${reason} Publisher not ready; attempt ${attempt + 1} in ${delayMs} ms.`,
            { subject: participantId },
          );
        } else {
          this.subscriptionRetries.set(participantId, {
            attempt: 1,
            nextAttemptAt: null,
            reason,
            publisherNotReady: false,
          });
          if (!(error instanceof MoqTransportError && error.code === "request_refused")) {
            this.raise("relay_failed");
          }
          this.log.record("failure", reason, { subject: participantId });
        }
      }
    }
    this.scheduleSubscriptionRetry();
    this.emit();
  }

  /** Local listener control for remote human tracks. AI intent stays in FR8 routing. */
  async setSubscription(participantId: string, enabled: boolean): Promise<void> {
    const participant = this.room?.participants.find((candidate) => candidate.id === participantId);
    if (
      !participant ||
      participant.id === this.options.session.participantId ||
      participant.simulated
    ) {
      return;
    }
    this.subscriptionIntent.set(participantId, enabled);
    persistSubscriptionIntent(this.options.session, this.subscriptionIntent);
    this.subscriptionRetries.delete(participantId);
    if (!enabled) {
      const player = this.players.get(participantId);
      if (player) {
        await this.unsubscribeParticipant(
          participantId,
          player,
          `audio/${participantId} disabled by listener`,
        );
      } else {
        this.log.record("unsubscribe", `audio/${participantId} disabled by listener`, {
          subject: participantId,
        });
      }
    } else {
      this.log.record("subscribe", `audio/${participantId} enabled by listener`, {
        subject: participantId,
      });
      await this.reconcileSubscriptions();
    }
    this.scheduleSubscriptionRetry();
    this.emit();
  }

  private async unsubscribeParticipant(
    participantId: string,
    player: TrackPlayer,
    detail = `audio/${participantId}`,
  ): Promise<void> {
    const room = this.room;
    if (!room) return;
    player.close();
    this.players.delete(participantId);
    this.subscriptionRetries.delete(participantId);
    await this.transport.unsubscribe(audioTrack(room.code, participantId)).catch(() => undefined);
    this.log.record("unsubscribe", detail, { subject: participantId });
  }

  private retryWaitingSubscriptionsNow(): void {
    const now = this.now();
    for (const [participantId, retry] of this.subscriptionRetries) {
      if (!retry.publisherNotReady) continue;
      this.subscriptionRetries.set(participantId, { ...retry, nextAttemptAt: now });
    }
    void this.reconcileSubscriptions();
  }

  private scheduleSubscriptionRetry(): void {
    this.clearSubscriptionRetryTimer();
    const due = [...this.subscriptionRetries.values()]
      .map((retry) => retry.nextAttemptAt)
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right)[0];
    if (due === undefined) return;
    this.subscriptionRetryTimer = setTimeout(
      () => {
        this.subscriptionRetryTimer = null;
        if (!this.closed) void this.reconcileSubscriptions();
      },
      Math.max(0, due - this.now()),
    );
  }

  private clearSubscriptionRetryTimer(): void {
    if (this.subscriptionRetryTimer) clearTimeout(this.subscriptionRetryTimer);
    this.subscriptionRetryTimer = null;
  }

  private async consume(
    participantId: string,
    player: TrackPlayer,
    stream: ReadableStream<{ groupId: number; objectId: number; payload: Uint8Array }>,
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) return;
        player.accept(value.groupId, value.objectId, value.payload, this.now());
        // Feeds the scripted responder only for pairs where consent is on, so
        // "Partial context" reflects what the AI actually received.
        this.noteScriptedContext(participantId);
      }
    } catch (error) {
      this.raise("relay_failed");
      this.log.record("failure", error instanceof Error ? error.message : "Subscription ended.", {
        subject: participantId,
      });
    } finally {
      reader.releaseLock();
    }
  }

  private noteScriptedContext(fromParticipantId: string): void {
    const room = this.room;
    if (!room) return;
    const sender = room.participants.find((participant) => participant.id === fromParticipantId);
    if (sender?.role !== "human") return;
    for (const ai of room.participants.filter((participant) => participant.role === "ai")) {
      const row = room.routing.find(
        (candidate) => candidate.aiId === ai.id && candidate.humanId === fromParticipantId,
      );
      if (row?.hearsMe) this.scripted.noteHeardUtterance(ai.id, fromParticipantId);
    }
  }

  /** FR3: no participant subscribes to itself, and outbound routing is local. */
  private subscribableParticipants(): Participant[] {
    const room = this.room;
    if (!room) return [];
    const paused = new Set(this.degradation.unsubscribed);
    return room.participants.filter((participant) => {
      if (participant.id === this.options.session.participantId) return false;
      if (participant.state === "left") return false;
      if (participant.simulated) return false;
      if (paused.has(trackKey(audioTrack(room.code, participant.id)))) return false;
      if (participant.role !== "ai") return this.subscriptionIntent.get(participant.id) ?? true;
      const row = room.routing.find(
        (candidate) =>
          candidate.aiId === participant.id &&
          candidate.humanId === this.options.session.participantId,
      );
      return row?.iHearIt ?? true;
    });
  }

  /**
   * Room namespace interest defaults on for every other real participant.
   * Explicit human and AI listening controls remain authoritative, including
   * when the relay offers a publisher-initiated subscription via PUBLISH.
   */
  private shouldAcceptPublishedTrack(track: { namespace: string; name: string }): boolean {
    const room = this.room;
    const parsed = parseTrackName(track.name);
    if (!room || parsed?.kind !== "audio") return false;
    if (parsed.participantId === this.options.session.participantId) return false;
    if (track.namespace !== participantNamespace(room.code, parsed.participantId)) return false;

    const participant = room.participants.find(
      (candidate) => candidate.id === parsed.participantId,
    );
    // A PUBLISH can outrun the control-plane membership event. Accept a
    // correctly scoped unknown participant by default and reconcile it when
    // the room snapshot arrives.
    if (!participant) return true;
    return this.subscribableParticipants().some(
      (candidate) => candidate.id === parsed.participantId,
    );
  }

  private subscriptionStates(): TrackSubscriptionState[] {
    const room = this.room;
    if (!room) return [];
    return (room.participants ?? [])
      .filter(
        (participant) =>
          participant.id !== this.options.session.participantId &&
          participant.state !== "left" &&
          !participant.simulated,
      )
      .map((participant) => {
        const intent = this.subscriptionIntentFor(participant);
        if (!intent) {
          return {
            participantId: participant.id,
            intent,
            status: "unsubscribed",
            detail: "Unsubscribed by this listener.",
          };
        }
        if (this.players.has(participant.id)) {
          return {
            participantId: participant.id,
            intent,
            status: "subscribed",
            detail: "The relay accepted this track subscription.",
          };
        }
        if (this.subscriptionsOpening.has(participant.id)) {
          return {
            participantId: participant.id,
            intent,
            status: "subscribing",
            detail: "Waiting for the relay to answer SUBSCRIBE.",
          };
        }
        const retry = this.subscriptionRetries.get(participant.id);
        if (retry) {
          return {
            participantId: participant.id,
            intent,
            status: "waiting",
            detail:
              retry.nextAttemptAt === null
                ? `${retry.reason} Automatic retries are paused; switch the control off and on to retry.`
                : `${retry.reason} Retrying with bounded backoff.`,
          };
        }
        return {
          participantId: participant.id,
          intent,
          status: "waiting",
          detail: "Waiting for a live relay session.",
        };
      });
  }

  private subscriptionIntentFor(participant: Participant): boolean {
    if (participant.role !== "ai") return this.subscriptionIntent.get(participant.id) ?? true;
    const row = this.room?.routing?.find(
      (candidate) =>
        candidate.aiId === participant.id &&
        candidate.humanId === this.options.session.participantId,
    );
    return row?.iHearIt ?? true;
  }

  private tickLadder(): void {
    const room = this.room;
    if (!room) return;
    const tracks = [...this.players.values()].map((player) => ({
      trackId: player.trackId,
      lastActiveAt: player.lastActiveAt,
    }));
    const worst = this.mixer.worstBufferMs();
    const underruns = this.mixer.totalUnderruns();
    const next = this.ladder.evaluate({
      activeSpeakers: tracks.filter((track) => this.now() - track.lastActiveAt < 2_000).length,
      worstBufferMs: worst.exposed ? worst.value : 0,
      underrunsInWindow: underruns.exposed ? underruns.value : 0,
      tracks,
      now: this.now(),
    });

    if (next.step !== this.degradation.step) {
      // H7: every step is announced. Silent degradation is the failure mode.
      if (next.step > 0) this.raise("beyond_measured_capacity");
      this.log.record("degradation", next.announcement ?? "Recovered to full quality");
      this.telemetry.record({ type: "degradation_step", value: next.step });
      for (const player of this.players.values()) player.setNominalBuffer(next.nominalBufferMs);
    }
    for (const trackId of next.releasedDecoders) {
      const player = [...this.players.values()].find((candidate) => candidate.trackId === trackId);
      if (player && !player.released) player.releaseDecoder();
    }
    this.degradation = next;
    void this.reconcileSubscriptions();
    this.emit();
  }

  private startDraining(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      const now = this.now();
      for (const player of this.players.values()) player.drain(now);
    }, DRAIN_INTERVAL_MS);
  }

  private openControlChannel(): void {
    // AGENTS.md: WebSockets carry control-plane membership only, never audio.
    const socket = new WebSocket(roomEventsUrl(this.options.session));
    socket.addEventListener("open", () => {
      if (socket !== this.socket || this.closed) return;
      const restored = this.controlReconnectAttempt > 0;
      this.controlReconnectAttempt = 0;
      if (this.controlRetryTimer) clearTimeout(this.controlRetryTimer);
      this.controlRetryTimer = null;
      if (restored) {
        this.log.record("reconnect", "Control channel restored; refreshing the room snapshot.");
        void this.refresh();
      }
      this.emit();
    });
    socket.addEventListener("message", (event) => {
      let parsed: RoomEvent;
      try {
        parsed = JSON.parse(String(event.data)) as RoomEvent;
      } catch {
        return;
      }
      this.applyEvent(parsed);
    });
    socket.addEventListener("close", (event) => {
      if (this.closed || socket !== this.socket) return;
      this.socket = null;
      const delayMs = Math.min(
        CONTROL_RETRY_MAX_MS,
        CONTROL_RETRY_BASE_MS * 2 ** this.controlReconnectAttempt,
      );
      this.controlReconnectAttempt += 1;
      this.log.record(
        "reconnect",
        `Control channel closed (${event.code || "no status"}); attempt ${this.controlReconnectAttempt} in ${delayMs} ms.`,
      );
      if (this.controlRetryTimer) clearTimeout(this.controlRetryTimer);
      this.controlRetryTimer = setTimeout(() => {
        this.controlRetryTimer = null;
        if (!this.closed) this.openControlChannel();
      }, delayMs);
      this.emit();
    });
    this.socket = socket;
  }

  private applyEvent(event: RoomEvent): void {
    switch (event.type) {
      case "snapshot":
        this.applyRoom(event.room);
        void this.reconcileSubscriptions();
        break;
      case "participant_changed":
        // FR4: an AI waits rather than answering on a reconnecting human.
        if (event.state === "reconnecting") this.director.suspendHuman(event.participantId);
        if (event.state === "connected") this.director.resumeHuman(event.participantId);
        if (event.state !== "connected") this.raise("participant_disconnected");
        void this.refresh();
        break;
      case "routing_changed":
      case "ai_pipeline_changed":
      case "floor_changed":
      case "ai_to_ai_changed":
        void this.refresh();
        break;
      case "room_expired":
        this.log.record("close", "Room reached its hard stop; all sessions closed.");
        void this.close();
        break;
    }
    this.emit();
  }

  private async refresh(): Promise<void> {
    // The snapshot the socket sends on connect is authoritative; between
    // events, re-read rather than patching local copies of server state.
    try {
      this.applyRoom(await fetchRoom(this.options.session.code));
      await this.reconcileSubscriptions();
    } catch {
      this.log.record("failure", "The room snapshot could not be refreshed.");
    }
    this.emit();
  }

  private applyRoom(room: RoomSnapshot): void {
    this.room = this.observedDiscovery
      ? { ...room, transport: { ...room.transport, discovery: this.observedDiscovery } }
      : room;
    for (const ai of room.participants.filter((participant) => participant.role === "ai")) {
      this.director.register(ai.id, "hold_to_ask");
      this.director.setAvailable(ai.id, ai.pipeline !== "unavailable");
    }
    this.director.setAiToAi(room.aiToAi.enabled);
  }

  private routingFor(aiId: string): RoutingPreference | undefined {
    return this.room?.routing.find(
      (row) => row.aiId === aiId && row.humanId === this.options.session.participantId,
    );
  }

  private async setPipeline(aiId: string, pipeline: AiPipelineState): Promise<void> {
    try {
      this.applyRoom(await setAiPipeline(this.options.session, aiId, pipeline));
    } catch {
      this.log.record("failure", "The AI pipeline state could not be recorded.", { subject: aiId });
    }
  }

  private raise(failure: FailureCode): void {
    this.failures = [failure, ...this.failures.filter((code) => code !== failure)].slice(0, 6);
    this.telemetry.record({ type: "failure", value: failure });
  }

  clearFailure(failure: FailureCode): void {
    this.failures = this.failures.filter((code) => code !== failure);
    this.emit();
  }

  /** §4.4: closes publications and subscriptions, stops capture, ends the session. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ladderTimer) clearInterval(this.ladderTimer);
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.controlRetryTimer) clearTimeout(this.controlRetryTimer);
    this.clearSubscriptionRetryTimer();
    this.ladderTimer = null;
    this.drainTimer = null;
    this.retryTimer = null;
    this.controlRetryTimer = null;
    this.subscriptionRetries.clear();
    this.subscriptionsOpening.clear();

    for (const player of this.players.values()) player.close();
    this.players.clear();
    this.devices.stop();
    await this.capture.stop();
    this.publishing = false;
    this.captureMode = { name: "idle" };
    await this.transport.close("participant left");
    await this.mixer.close();
    await this.lifecycle.dispose();
    this.playbackDeduplicator.clear();
    this.socket?.close(1000, "left");
    this.socket = null;
    this.log.record("close", "Capture stopped, publications and subscriptions closed.");
    this.setPhase({ name: "left" });
  }

  private setPhase(phase: SessionPhase): void {
    this.phase = phase;
    this.emit();
  }

  private emit(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }

  private snapshot(): SessionState {
    return {
      phase: this.phase,
      room: this.room,
      failures: [...this.failures],
      degradation: this.degradation,
      publishing: this.publishing,
      muted: this.muted,
      capture: this.captureMode,
      audioLifecycle: { ...this.lifecycleState },
      subscribedParticipantIds: [...this.players.keys()],
      subscriptions: this.subscriptionStates(),
      speaking: this.capture.speaking,
      micLevel: this.capture.level,
      metrics: this.metrics(),
      negotiation: this.transport.sessionStats().negotiation,
      network: this.network,
      events: this.log.list(),
    };
  }

  private metrics(): SessionMetrics {
    const stats = this.transport.sessionStats();
    const players = [...this.players.values()];
    const subscribed = players.map((player) => player.participantId);
    const counts = fanOut(subscribed, this.publishing);
    const objectStats = players.map((player) => player.objectStats());
    const lateDrops = objectStats.reduce(
      (sum, entry) => sum + (entry.lateDrops.exposed ? entry.lateDrops.value : 0),
      0,
    );
    const cancelled = objectStats.reduce(
      (sum, entry) => sum + (entry.cancelledDrops.exposed ? entry.cancelledDrops.value : 0),
      0,
    );
    const concealed = objectStats.reduce(
      (sum, entry) => sum + (entry.concealedFrames.exposed ? entry.concealedFrames.value : 0),
      0,
    );
    const comfortNoise = objectStats.reduce(
      (sum, entry) => sum + (entry.comfortNoiseFrames.exposed ? entry.comfortNoiseFrames.value : 0),
      0,
    );
    const objects = objectStats.reduce(
      (sum, entry) => sum + (entry.objects.exposed ? entry.objects.value : 0),
      0,
    );
    const objectBytes = objectStats.reduce(
      (sum, entry) =>
        sum +
        (entry.objects.exposed && entry.meanBytes.exposed
          ? entry.objects.value * entry.meanBytes.value
          : 0),
      0,
    );
    const bufferDepths = objectStats.flatMap((entry) =>
      entry.depthMs.exposed ? [entry.depthMs.value] : [],
    );
    const driftEstimates = objectStats.flatMap((entry) =>
      entry.skewPpm.exposed ? [Math.abs(entry.skewPpm.value)] : [],
    );
    const liveFor =
      this.transportReadyAt === null ? 0 : (this.now() - this.transportReadyAt) / 1000;

    const unavailable = "Live transport has not been established, so this is not observable.";
    const noObjects = "No subscribed audio object has arrived yet.";
    const transportEstablished = this.transportReadyAt !== null;
    return {
      transportReadyMs:
        this.transportReadyAt === null
          ? notExposed(unavailable)
          : measured(this.transportReadyAt - (this.startedAt ?? this.transportReadyAt)),
      firstAudioMs:
        this.firstAudioAt === null || this.startedAt === null
          ? notExposed("No audio object has arrived yet.")
          : measured(this.firstAudioAt - this.startedAt),
      publishedTracks: this.publishing
        ? measured(counts.publishedTracks)
        : notExposed("This participant is not publishing."),
      subscribedTracks:
        this.phase.name === "live" ? measured(counts.subscribedTracks) : notExposed(unavailable),
      worstBufferMs:
        bufferDepths.length === 0 ? notExposed(noObjects) : measured(Math.max(...bufferDepths)),
      outputLatencyMs: this.mixer.outputLatencyMs(),
      transportRttMs:
        typeof stats.transportRttMs === "number"
          ? measured(stats.transportRttMs)
          : notExposed("The browser does not expose a WebTransport round-trip time."),
      lateDrops: players.length === 0 ? notExposed(unavailable) : measured(lateDrops),
      cancelledDrops: players.length === 0 ? notExposed(unavailable) : measured(cancelled),
      concealedFrames: players.length === 0 ? notExposed(unavailable) : measured(concealed),
      comfortNoiseFrames: players.length === 0 ? notExposed(unavailable) : measured(comfortNoise),
      lastBargeInMs:
        this.lastBargeIn === null
          ? notExposed("No barge-in has occurred in this session.")
          : measured(this.lastBargeIn.latencyMs),
      lastRoutingChangeMs:
        this.lastRoutingChangeMs === null
          ? notExposed("No routing change has occurred in this session.")
          : measured(this.lastRoutingChangeMs),
      reconnects: measured(this.reconnects),
      dtxEnabled: this.publishing
        ? this.capture.dtxEnabled()
        : notExposed("This participant is not publishing."),
      capturePath: this.publishing
        ? this.capture.capturePath()
        : notExposed("This participant is not publishing."),
      publishedObjects: transportEstablished
        ? measured(stats.publishedObjects)
        : notExposed(unavailable),
      subscribedObjects: transportEstablished
        ? measured(stats.subscribedObjects)
        : notExposed(unavailable),
      objectsPerSecond:
        liveFor < 1
          ? notExposed("Too little live time to compute an object rate.")
          : measured(objects / liveFor),
      meanObjectBytes: objects === 0 ? notExposed(noObjects) : measured(objectBytes / objects),
      lateDropRate: objects === 0 ? notExposed(noObjects) : measured(lateDrops / objects),
      aggregateBufferMs:
        bufferDepths.length === 0
          ? notExposed(noObjects)
          : measured(bufferDepths.reduce((sum, depth) => sum + depth, 0)),
      worstDriftPpm:
        driftEstimates.length === 0
          ? notExposed("No subscribed track has enough arrivals for a drift estimate.")
          : measured(Math.max(...driftEstimates)),
      activeDecoders: transportEstablished
        ? measured(players.filter((player) => !player.released).length)
        : notExposed(unavailable),
      audioInputs: this.devices.inputCount(),
      deviceChanges: this.devices.deviceChanges(),
    };
  }

  private transportReadyMsRaw(): number | null {
    if (this.transportReadyAt === null || this.startedAt === null) return null;
    return this.transportReadyAt - this.startedAt;
  }

  private get relayCredential(): string | null {
    return relayCredentials.get(this.options.session.participantId) ?? null;
  }
}

/**
 * Relay credentials are held in memory only, keyed by participant. They are
 * never written to storage, never logged and never placed in a URL the user
 * could share (§8).
 */
const relayCredentials = new Map<string, string>();

export function rememberRelayCredential(participantId: string, credential: string | null): void {
  if (credential) relayCredentials.set(participantId, credential);
  else relayCredentials.delete(participantId);
}

function subscriptionIntentKey(session: StoredSession): string {
  return `real-fabric:subscriptions:${session.code}:${session.participantId}`;
}

function restoreSubscriptionIntent(session: StoredSession): Array<[string, boolean]> {
  try {
    if (typeof sessionStorage === "undefined") return [];
    const parsed = JSON.parse(
      sessionStorage.getItem(subscriptionIntentKey(session)) ?? "[]",
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is [string, boolean] =>
        Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "boolean",
    );
  } catch {
    return [];
  }
}

function persistSubscriptionIntent(
  session: StoredSession,
  intent: ReadonlyMap<string, boolean>,
): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(subscriptionIntentKey(session), JSON.stringify([...intent]));
  } catch {
    // Storage can be disabled; controls still apply for the live page lifetime.
  }
}

/** §6.2: relay-visible identifiers stay opaque, so the header carries a hash. */
function hashParticipant(participantId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < participantId.length; index += 1) {
    hash ^= participantId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
