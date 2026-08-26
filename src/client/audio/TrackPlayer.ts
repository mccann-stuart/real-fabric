import { type Measurement, measured, notExposed } from "../../shared/measurement";
import { AdaptiveJitterBuffer } from "./AdaptiveJitterBuffer";
import { type DriftCorrection, DriftEstimator } from "./DriftEstimator";
import { AUDIO_FRAME_DURATION_MS, type AudioFrameMetadata, decodeAudioObject } from "./frame";
import { MEDIA_SAMPLE_RATE, type MixerGraph } from "./MixerGraph";
import { type ConcealmentKind, PacketLossConcealer } from "./PacketLossConcealer";
import { PlaybackDeduplicator } from "./PlaybackDeduplicator";

/**
 * One subscribed participant's receive path: deduplicate, buffer, decode,
 * conceal loss, estimate drift, hand PCM to the single mixing worklet.
 *
 * There is one of these per subscribed track (FR3). Nothing here mixes; the
 * worklet does that, once, for everyone.
 */

/**
 * A gap in the sequence means frames were lost or dropped for lateness, and is
 * concealed. Beyond this many, concealing further would add latency without
 * adding intelligibility, so the remainder is counted and skipped (H13).
 */
export const MAXIMUM_CONCEALED_FRAMES_PER_GAP = 10;
/**
 * §11.3: severe drift rebuilds the buffer at a silence rather than mid-word.
 * This is the pause that counts as one — long enough not to be jitter, short
 * enough to occur between utterances.
 */
export const SILENCE_REBUILD_GAP_MS = 250;
/**
 * A speaker who never pauses must not defer the rebuild forever. Past this the
 * rebuild happens anyway; a brief artefact beats unbounded skew.
 */
export const MAXIMUM_REBUILD_DEFERRAL_MS = 10_000;

export interface TrackPlayerCallbacks {
  onFirstObject?: (trackId: string) => void;
  onDriftCorrection?: (correction: DriftCorrection) => void;
  onDriftBeyondRange?: (trackId: string) => void;
  /** §10.5: a concealed gap is a quality warning, never silent. */
  onConcealment?: (trackId: string, frames: number, kind: ConcealmentKind) => void;
  onError?: (trackId: string, error: Error) => void;
}

export class TrackPlayer {
  readonly buffer = new AdaptiveJitterBuffer<{ metadata: AudioFrameMetadata; frame: Uint8Array }>();
  private readonly drift: DriftEstimator;
  private readonly concealer = new PacketLossConcealer();
  private decoder: AudioDecoder | null = null;
  private firstObjectAt: number | null = null;
  private lastObjectAt: number | null = null;
  private objects = 0;
  private bytes = 0;
  private decoderReleased = false;
  private lastPlayedSequence: number | null = null;
  private concealedFrames = 0;
  private comfortNoiseFrames = 0;
  /** Set when drift leaves the correctable range; cleared when the rebuild runs. */
  private rebuildPendingSince: number | null = null;
  /** H6: set while a cancelled group is still arriving. */
  private cancelledGroups = new Set<number>();

  constructor(
    readonly participantId: string,
    readonly trackId: string,
    private readonly mixer: MixerGraph,
    private readonly callbacks: TrackPlayerCallbacks = {},
    private readonly dedupe: PlaybackDeduplicator = new PlaybackDeduplicator(),
  ) {
    this.drift = new DriftEstimator(trackId);
  }

  /** Called for each MOQT object delivered on this track. */
  accept(groupId: number, objectId: number, payload: Uint8Array, now: number): void {
    // H12: a reload resubscribes from a position already played. Deduplicate
    // before anything else so nothing reaches the mixer twice.
    if (!this.dedupe.accept(this.participantId, groupId, objectId)) return;

    let decoded: { metadata: AudioFrameMetadata; opusFrame: Uint8Array };
    try {
      decoded = decodeAudioObject(payload);
    } catch (error) {
      this.callbacks.onError?.(
        this.trackId,
        error instanceof Error ? error : new Error("Malformed audio object."),
      );
      return;
    }

    // H6: the publisher's cancellation marker closes the group. Everything else
    // from that group is discarded, including objects already on the wire.
    if (decoded.metadata.cancelled) {
      this.cancelGroup(groupId);
      return;
    }
    if (this.cancelledGroups.has(groupId)) return;

    this.objects += 1;
    this.bytes += payload.byteLength;
    this.lastObjectAt = now;
    if (this.firstObjectAt === null) {
      this.firstObjectAt = now;
      // §6.2: audio object arrival, not presence, is the source of truth.
      this.callbacks.onFirstObject?.(this.trackId);
    }
    if (this.decoderReleased) this.decoderReleased = false;

    this.drift.observe(decoded.metadata.mediaTimestamp, now);
    const correction = this.drift.recordCorrection(now);
    if (correction) {
      this.mixer.setRatio(this.trackId, correction.ratio);
      this.callbacks.onDriftCorrection?.(correction);
    }
    if (this.drift.health() === "beyond_range" && this.rebuildPendingSince === null) {
      // §11.3: schedule the rebuild, then wait for a pause. Rebuilding mid-word
      // trades one audible artefact for another.
      this.rebuildPendingSince = now;
      this.callbacks.onDriftBeyondRange?.(this.trackId);
    }

    this.buffer.push({
      sequence: decoded.metadata.sequence,
      groupId,
      receivedAt: now,
      value: { metadata: decoded.metadata, frame: decoded.opusFrame },
    });
  }

  /** Releases frames whose buffer delay has elapsed into the decoder. */
  drain(now: number): void {
    for (;;) {
      const next = this.buffer.pull(now);
      if (!next) break;
      this.concealGapBefore(next.metadata.sequence);
      this.lastPlayedSequence = next.metadata.sequence;
      this.decodeFrame(next.metadata, next.frame);
    }
    this.rebuildIfSettled(now);
  }

  /**
   * §10.5: frames missing between the last one played and this one were lost or
   * dropped late. Opus packet loss concealment fills them so pitch continues,
   * and a sustained run becomes comfort noise rather than a held buzz.
   */
  private concealGapBefore(sequence: number): void {
    if (this.lastPlayedSequence === null) return;
    const missing = sequence - this.lastPlayedSequence - 1;
    if (missing <= 0) return;

    const conceal = Math.min(missing, MAXIMUM_CONCEALED_FRAMES_PER_GAP);
    let kind: ConcealmentKind = "pitch_repeat";
    for (let index = 0; index < conceal; index += 1) {
      const concealment = this.concealer.conceal();
      if (!concealment) break;
      kind = concealment.kind;
      this.mixer.pushSamples(this.trackId, concealment.samples);
      this.concealedFrames += 1;
      if (concealment.kind === "comfort_noise") this.comfortNoiseFrames += 1;
    }
    this.callbacks.onConcealment?.(this.trackId, missing, kind);
  }

  /**
   * §11.3 deliverable four: the deferred rebuild for uncorrectable drift, run
   * at the first pause — or once the deferral bound is reached, so a
   * continuous speaker cannot postpone it indefinitely.
   */
  private rebuildIfSettled(now: number): void {
    const pendingSince = this.rebuildPendingSince;
    if (pendingSince === null) return;

    const silent = this.lastObjectAt === null || now - this.lastObjectAt >= SILENCE_REBUILD_GAP_MS;
    const deferredTooLong = now - pendingSince >= MAXIMUM_REBUILD_DEFERRAL_MS;
    if (!silent && !deferredTooLong) return;

    this.buffer.clear();
    this.mixer.flush(this.trackId);
    this.mixer.setRatio(this.trackId, 1);
    this.drift.reset();
    this.concealer.reset();
    this.lastPlayedSequence = null;
    this.rebuildPendingSince = null;
  }

  /** True while a drift rebuild is waiting for a pause. Surfaced in the inspector. */
  get rebuildPending(): boolean {
    return this.rebuildPendingSince !== null;
  }

  /** H6: barge-in. Returns how many objects were discarded. */
  cancelGroup(groupId: number): number {
    this.cancelledGroups.add(groupId);
    if (this.cancelledGroups.size > 8) {
      this.cancelledGroups.delete(Math.min(...this.cancelledGroups));
    }
    const dropped = this.buffer.cancelGroup(groupId);
    // Drop what the worklet already holds too, or the tail still plays.
    this.mixer.flush(this.trackId);
    // A cancelled turn is not a lost frame: resume from whatever comes next
    // rather than concealing the gap the cancellation deliberately created.
    this.lastPlayedSequence = null;
    this.concealer.reset();
    return dropped;
  }

  /** Ladder step two: release the decoder for a long-silent track. */
  releaseDecoder(): void {
    if (this.decoderReleased) return;
    this.decoderReleased = true;
    this.closeDecoder();
    this.buffer.clear();
    this.concealer.reset();
    this.lastPlayedSequence = null;
    this.mixer.removeTrack(this.trackId);
  }

  get released(): boolean {
    return this.decoderReleased;
  }

  get lastActiveAt(): number {
    return this.lastObjectAt ?? 0;
  }

  setNominalBuffer(nominalMs: number): void {
    this.buffer.setNominal(nominalMs);
  }

  objectStats(): {
    objects: Measurement<number>;
    meanBytes: Measurement<number>;
    lateDrops: Measurement<number>;
    cancelledDrops: Measurement<number>;
    concealedFrames: Measurement<number>;
    comfortNoiseFrames: Measurement<number>;
    depthMs: Measurement<number>;
    skewPpm: Measurement<number>;
  } {
    if (this.objects === 0) {
      const reason = "No object has arrived on this track yet.";
      return {
        objects: notExposed(reason),
        meanBytes: notExposed(reason),
        lateDrops: notExposed(reason),
        cancelledDrops: notExposed(reason),
        concealedFrames: notExposed(reason),
        comfortNoiseFrames: notExposed(reason),
        depthMs: notExposed(reason),
        skewPpm: notExposed(reason),
      };
    }
    return {
      objects: measured(this.objects),
      meanBytes: measured(this.bytes / this.objects),
      lateDrops: measured(this.buffer.lateDrops),
      cancelledDrops: measured(this.buffer.cancelledDrops),
      concealedFrames: measured(this.concealedFrames),
      comfortNoiseFrames: measured(this.comfortNoiseFrames),
      depthMs: measured(this.buffer.depthMs),
      skewPpm: this.drift.skewPpm(),
    };
  }

  close(): void {
    this.closeDecoder();
    this.buffer.clear();
    this.concealer.reset();
    this.mixer.removeTrack(this.trackId);
  }

  private decodeFrame(metadata: AudioFrameMetadata, frame: Uint8Array): void {
    const decoder = this.ensureDecoder();
    if (!decoder) return;
    try {
      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: metadata.mediaTimestamp * 1_000,
          duration: AUDIO_FRAME_DURATION_MS * 1_000,
          data: frame,
        }),
      );
    } catch (error) {
      this.callbacks.onError?.(
        this.trackId,
        error instanceof Error ? error : new Error("Opus decode failed."),
      );
    }
  }

  private ensureDecoder(): AudioDecoder | null {
    if (this.decoder) return this.decoder;
    if (!("AudioDecoder" in globalThis)) {
      this.callbacks.onError?.(
        this.trackId,
        new Error("WebCodecs AudioDecoder is not exposed by this browser."),
      );
      return null;
    }
    const decoder = new AudioDecoder({
      output: (data) => this.emit(data),
      error: (error) =>
        this.callbacks.onError?.(this.trackId, new Error(`Opus decoder failed: ${error.name}`)),
    });
    decoder.configure({
      codec: "opus",
      sampleRate: MEDIA_SAMPLE_RATE,
      numberOfChannels: 1,
    });
    this.decoder = decoder;
    this.mixer.addTrack(this.trackId);
    return decoder;
  }

  private emit(data: AudioData): void {
    try {
      const samples = new Float32Array(data.numberOfFrames);
      data.copyTo(samples, { planeIndex: 0 });
      // The concealer keeps its own copy; the original is transferred away.
      this.concealer.observe(samples);
      this.mixer.pushSamples(this.trackId, samples);
    } finally {
      data.close();
    }
  }

  private closeDecoder(): void {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }
}
