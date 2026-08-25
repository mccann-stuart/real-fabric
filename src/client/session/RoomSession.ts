import type {
  AiPipelineState,
  Participant,
  RoomEvent,
  RoomSnapshot,
  RoutingPreference,
} from "../../shared/contracts";
import { ROUTING_CHANGE_BUDGET_MS } from "../../shared/contracts";
import type { FailureCode } from "../../shared/failures";
import { type Measurement, measured, notExposed } from "../../shared/measurement";
import { audioTrack, fanOut, roomNamespace, trackKey } from "../../shared/tracks";
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
import { encodeAudioObject } from "../audio/frame";
import { MixerGraph } from "../audio/MixerGraph";
import { TrackPlayer } from "../audio/TrackPlayer";
import { SessionTelemetry } from "../telemetry/SessionTelemetry";
import { MoqTransportAdapter, MoqTransportError } from "../transport/MoqTransportAdapter";
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
  | { name: "connecting_transport" }
  | { name: "live" }
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
  lastBargeInMs: Measurement<number>;
  lastRoutingChangeMs: Measurement<number>;
  reconnects: Measurement<number>;
  dtxEnabled: Measurement<boolean>;
  objectsPerSecond: Measurement<number>;
}

export interface SessionState {
  phase: SessionPhase;
  room: RoomSnapshot | null;
  /** Distinct active failures, most recent first. Never a single generic one. */
  failures: FailureCode[];
  degradation: LadderState;
  publishing: boolean;
  speaking: boolean;
  micLevel: number;
  metrics: SessionMetrics;
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

export class RoomSession {
  readonly director = new AiDirector();
  readonly scripted = new ScriptedResponder();
  readonly telemetry = new SessionTelemetry();

  private readonly log = new SessionEventLog();
  private readonly transport = new MoqTransportAdapter();
  private readonly mixer = new MixerGraph();
  private readonly capture = new CaptureController();
  private readonly ladder = new DegradationLadder();
  private readonly reconnection = new ReconnectionPolicy();
  private readonly players = new Map<string, TrackPlayer>();
  private readonly now: () => number;

  private listeners = new Set<(state: SessionState) => void>();
  private socket: WebSocket | null = null;
  private phase: SessionPhase = { name: "idle" };
  private room: RoomSnapshot | null = null;
  private failures: FailureCode[] = [];
  private degradation: LadderState = {
    step: 0,
    nominalBufferMs: 60,
    releasedDecoders: [],
    unsubscribed: [],
    announcement: null,
  };
  private publishing = false;
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
  private closed = false;

  constructor(private readonly options: RoomSessionOptions) {
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /**
   * Applies a room snapshot the caller already fetched, then opens the control
   * channel and evaluates transport. Deliberately does not request the
   * microphone: FR2 requires an explicit user action for that.
   */
  async start(room: RoomSnapshot): Promise<void> {
    this.startedAt = this.now();
    this.applyRoom(room);
    this.openControlChannel();
    this.ladderTimer = setInterval(() => this.tickLadder(), LADDER_INTERVAL_MS);
    await this.openTransport();
  }

  /**
   * H1: the only transport path. When the room service reports the draft or
   * relay unavailable, this records that specific failure and stops. It never
   * tries a different draft or a different transport.
   */
  private async openTransport(): Promise<void> {
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
      this.raise("draft_endpoint_missing");
      this.setPhase({ name: "blocked", failure: "draft_endpoint_missing" });
      this.log.record(
        "failure",
        "The room service minted no relay credential, so no MOQT session was attempted.",
      );
      return;
    }

    try {
      await this.transport.connect(room.transport.endpoint, credential, room.transport.draft);
      this.transportReadyAt = this.now();
      this.reconnection.reset();
      this.log.record("connect", `MOQT draft ${room.transport.draft} session established`);
      this.telemetry.record({ type: "transport_ready", value: this.transportReadyMsRaw() ?? 0 });
      await this.discover(room);
      await this.reconcileSubscriptions();
      this.setPhase({ name: "live" });
      this.startDraining();
    } catch (error) {
      await this.handleTransportFailure(error);
    }
  }

  /** FR7: try the MoQ primitive, and say which mechanism actually carried it. */
  private async discover(room: RoomSnapshot): Promise<void> {
    if (room.transport.discovery !== "subscribe_namespace") {
      this.raise("namespace_discovery_unavailable");
      this.log.record(
        "subscribe",
        "Discovery is using the room service control channel, not SUBSCRIBE_NAMESPACE.",
      );
      return;
    }
    try {
      await this.transport.subscribeNamespace(roomNamespace(room.code));
      this.log.record("subscribe", `SUBSCRIBE_NAMESPACE on ${roomNamespace(room.code)}`);
    } catch {
      this.raise("namespace_discovery_unavailable");
      this.log.record(
        "subscribe",
        "SUBSCRIBE_NAMESPACE was refused; falling back to control-channel discovery.",
      );
    }
  }

  private async handleTransportFailure(error: unknown): Promise<void> {
    const failure: FailureCode =
      error instanceof MoqTransportError
        ? error.code === "draft_mismatch"
          ? "draft_mismatch"
          : error.code === "draft_unavailable"
            ? "transport_unsupported"
            : "relay_failed"
        : "relay_failed";
    this.raise(failure);
    this.log.record("failure", error instanceof Error ? error.message : "Transport failed.");

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

  /** FR5: the presenter's explicit retry after a terminal failure. */
  async retry(): Promise<void> {
    this.reconnection.reset();
    this.failures = [];
    await this.openTransport();
  }

  /**
   * FR2: publication starts only on an explicit user action, and a denied
   * microphone leaves listening and inspection working.
   */
  async startPublishing(): Promise<void> {
    if (this.publishing) return;
    try {
      await this.mixer.start();
      await this.capture.start({
        onEncodedFrame: (frame) => this.publishFrame(frame),
        onOnset: () => void this.onHumanOnset(),
        onRelease: () => this.emit(),
        onError: (error) => {
          this.raise("audio_behind");
          this.log.record("failure", error.message);
        },
      });
      this.publishing = true;
      this.log.record("publish", `audio/${this.options.session.participantId}`);
      this.telemetry.record({ type: "publication_opened" });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      this.raise(
        name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "microphone_no_device"
          : name === "NotAllowedError" || name === "SecurityError"
            ? "microphone_denied"
            : "transport_unsupported",
      );
      this.log.record("failure", error instanceof Error ? error.message : "Capture failed.");
    }
    this.emit();
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
      .catch((error: unknown) => {
        this.raise("relay_failed");
        this.log.record("failure", error instanceof Error ? error.message : "Publish failed.");
      });
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

    for (const [participantId, player] of this.players) {
      if (wanted.has(participantId)) continue;
      player.close();
      this.players.delete(participantId);
      await this.transport.unsubscribe(audioTrack(room.code, participantId)).catch(() => undefined);
      this.log.record("unsubscribe", `audio/${participantId}`, { subject: participantId });
    }

    for (const participantId of wanted) {
      if (this.players.has(participantId)) continue;
      const track = audioTrack(room.code, participantId);
      const player = new TrackPlayer(participantId, trackKey(track), this.mixer, {
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
          this.log.record("drift", "Beyond correction range; buffer rebuilt", {
            subject: participantId,
          });
        },
        onError: (_trackId, error) => {
          this.raise("audio_behind");
          this.log.record("failure", error.message, { subject: participantId });
        },
      });
      this.players.set(participantId, player);
      this.log.record("subscribe", `audio/${participantId}`, { subject: participantId });

      try {
        const stream = await this.transport.subscribe(track);
        void this.consume(participantId, player, stream);
      } catch (error) {
        this.players.delete(participantId);
        player.close();
        this.raise("relay_failed");
        this.log.record("failure", error instanceof Error ? error.message : "Subscribe failed.");
      }
    }
    this.emit();
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
      if (participant.role !== "ai") return true;
      const row = room.routing.find(
        (candidate) =>
          candidate.aiId === participant.id &&
          candidate.humanId === this.options.session.participantId,
      );
      return row?.iHearIt ?? true;
    });
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
    socket.addEventListener("message", (event) => {
      let parsed: RoomEvent;
      try {
        parsed = JSON.parse(String(event.data)) as RoomEvent;
      } catch {
        return;
      }
      this.applyEvent(parsed);
    });
    socket.addEventListener("close", () => {
      if (this.closed) return;
      this.log.record("reconnect", "Control channel closed; membership updates paused.");
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
    this.room = room;
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
    this.ladderTimer = null;
    this.drainTimer = null;
    this.retryTimer = null;

    for (const player of this.players.values()) player.close();
    this.players.clear();
    await this.capture.stop();
    this.publishing = false;
    await this.transport.close("participant left");
    await this.mixer.close();
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
      speaking: this.capture.speaking,
      micLevel: this.capture.level,
      metrics: this.metrics(),
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
    const objects = objectStats.reduce(
      (sum, entry) => sum + (entry.objects.exposed ? entry.objects.value : 0),
      0,
    );
    const liveFor =
      this.transportReadyAt === null ? 0 : (this.now() - this.transportReadyAt) / 1000;

    const unavailable = "Live transport has not been established, so this is not observable.";
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
      worstBufferMs: this.mixer.worstBufferMs(),
      outputLatencyMs: this.mixer.outputLatencyMs(),
      transportRttMs:
        typeof stats.transportRttMs === "number"
          ? measured(stats.transportRttMs)
          : notExposed("The browser does not expose a WebTransport round-trip time."),
      lateDrops: players.length === 0 ? notExposed(unavailable) : measured(lateDrops),
      cancelledDrops: players.length === 0 ? notExposed(unavailable) : measured(cancelled),
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
      objectsPerSecond:
        liveFor < 1
          ? notExposed("Too little live time to compute an object rate.")
          : measured(objects / liveFor),
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

/** §6.2: relay-visible identifiers stay opaque, so the header carries a hash. */
function hashParticipant(participantId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < participantId.length; index += 1) {
    hash ^= participantId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
