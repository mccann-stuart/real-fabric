import { type Measurement, measured, notExposed } from "../../shared/measurement";
import { AdaptiveJitterBuffer } from "./AdaptiveJitterBuffer";
import { type DriftCorrection, DriftEstimator } from "./DriftEstimator";
import { type AudioFrameMetadata, decodeAudioObject } from "./frame";
import { MEDIA_SAMPLE_RATE, type MixerGraph } from "./MixerGraph";
import { PlaybackDeduplicator } from "./PlaybackDeduplicator";

/**
 * One subscribed participant's receive path: deduplicate, buffer, decode,
 * estimate drift, hand PCM to the single mixing worklet.
 *
 * There is one of these per subscribed track (FR3). Nothing here mixes; the
 * worklet does that, once, for everyone.
 */

export interface TrackPlayerCallbacks {
  onFirstObject?: (trackId: string) => void;
  onDriftCorrection?: (correction: DriftCorrection) => void;
  onDriftBeyondRange?: (trackId: string) => void;
  onError?: (trackId: string, error: Error) => void;
}

export class TrackPlayer {
  readonly buffer = new AdaptiveJitterBuffer<{ metadata: AudioFrameMetadata; frame: Uint8Array }>();
  private readonly drift: DriftEstimator;
  private readonly dedupe = new PlaybackDeduplicator();
  private decoder: AudioDecoder | null = null;
  private firstObjectAt: number | null = null;
  private lastObjectAt: number | null = null;
  private objects = 0;
  private bytes = 0;
  private decoderReleased = false;
  /** H6: set while a cancelled group is still arriving. */
  private cancelledGroups = new Set<number>();

  constructor(
    readonly participantId: string,
    readonly trackId: string,
    private readonly mixer: MixerGraph,
    private readonly callbacks: TrackPlayerCallbacks = {},
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
    if (this.drift.health() === "beyond_range") {
      // FR3: rebuild rather than fight it, and say so on that track only.
      this.buffer.clear();
      this.mixer.flush(this.trackId);
      this.drift.reset();
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
      if (!next) return;
      this.decodeFrame(next.metadata, next.frame);
    }
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
    return dropped;
  }

  /** Ladder step two: release the decoder for a long-silent track. */
  releaseDecoder(): void {
    if (this.decoderReleased) return;
    this.decoderReleased = true;
    this.closeDecoder();
    this.buffer.clear();
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
        depthMs: notExposed(reason),
        skewPpm: notExposed(reason),
      };
    }
    return {
      objects: measured(this.objects),
      meanBytes: measured(this.bytes / this.objects),
      lateDrops: measured(this.buffer.lateDrops),
      cancelledDrops: measured(this.buffer.cancelledDrops),
      depthMs: measured(this.buffer.depthMs),
      skewPpm: this.drift.skewPpm(),
    };
  }

  close(): void {
    this.closeDecoder();
    this.buffer.clear();
    this.dedupe.clear();
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
          duration: 20_000,
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
