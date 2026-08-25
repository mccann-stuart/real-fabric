import { type Measurement, measured, notExposed } from "../../shared/measurement";
import { AUDIO_FRAME_DURATION_MS } from "./frame";

/**
 * FR3: one bounded adaptive jitter buffer per subscribed track, nominal 60 ms,
 * bounded 40 to 200 ms, adapting to observed inter-arrival jitter and underrun
 * rate.
 *
 * Bounded is the load-bearing word. H13 requires ten minutes of continuous
 * audio with no unbounded buffer growth, so every path here either releases a
 * frame or counts a drop.
 */

export const NOMINAL_BUFFER_MS = 60;
export const MINIMUM_BUFFER_MS = 40;
export const MAXIMUM_BUFFER_MS = 200;

export interface BufferedFrame<T> {
  sequence: number;
  /** One group is one second of audio (§6.3) and the barge-in cancellation unit. */
  groupId: number;
  receivedAt: number;
  value: T;
}

export class AdaptiveJitterBuffer<T> {
  readonly minimumMs = MINIMUM_BUFFER_MS;
  readonly maximumMs = MAXIMUM_BUFFER_MS;
  /** Ladder step one raises this; adaptation works around it. */
  nominalMs = NOMINAL_BUFFER_MS;
  targetMs = NOMINAL_BUFFER_MS;
  lateDrops = 0;
  underruns = 0;
  /** H6: objects discarded because their group was cancelled. */
  cancelledDrops = 0;
  private frames: BufferedFrame<T>[] = [];
  private lastArrivalAt: number | null = null;
  private jitterMs = 0;
  private cancelledGroups = new Set<number>();

  push(frame: BufferedFrame<T>): void {
    // H6: an object from a cancelled group is discarded at the receiver even
    // though it arrived. This is what makes barge-in include objects in flight.
    if (this.cancelledGroups.has(frame.groupId)) {
      this.cancelledDrops += 1;
      return;
    }
    if (this.frames.some((candidate) => candidate.sequence === frame.sequence)) return;

    if (this.lastArrivalAt !== null) {
      const intervalError = Math.abs(
        frame.receivedAt - this.lastArrivalAt - AUDIO_FRAME_DURATION_MS,
      );
      this.jitterMs += (intervalError - this.jitterMs) / 16;
      this.retarget();
    }
    this.lastArrivalAt = frame.receivedAt;

    this.frames.push(frame);
    this.frames.sort((left, right) => left.sequence - right.sequence);

    // Anything older than the maximum bound can never be played usefully.
    const staleBefore = frame.receivedAt - this.maximumMs;
    const retained = this.frames.filter((candidate) => candidate.receivedAt >= staleBefore);
    this.lateDrops += this.frames.length - retained.length;
    this.frames = retained;
  }

  pull(now: number): T | undefined {
    const index = this.frames.findIndex((frame) => frame.receivedAt <= now - this.targetMs);
    if (index < 0) {
      this.underruns += 1;
      // A run of underruns means the target is too tight for this path.
      if (this.underruns % 8 === 0) {
        this.jitterMs += AUDIO_FRAME_DURATION_MS / 2;
        this.retarget();
      }
      return undefined;
    }
    return this.frames.splice(index, 1)[0]?.value;
  }

  /**
   * H6: cancel a group. Frames already buffered go now, and frames still in
   * flight are refused on arrival.
   */
  cancelGroup(groupId: number): number {
    this.cancelledGroups.add(groupId);
    const before = this.frames.length;
    this.frames = this.frames.filter((frame) => frame.groupId !== groupId);
    const dropped = before - this.frames.length;
    this.cancelledDrops += dropped;
    // Bound the cancellation memory; groups are monotonic and one second long.
    if (this.cancelledGroups.size > 8) {
      const oldest = Math.min(...this.cancelledGroups);
      this.cancelledGroups.delete(oldest);
    }
    return dropped;
  }

  /** FR3 ladder step one: adopt a raised nominal without losing adaptation. */
  setNominal(nominalMs: number): void {
    this.nominalMs = clamp(nominalMs, this.minimumMs, this.maximumMs);
    this.retarget();
  }

  /** FR3: rebuild this track's buffer, used at a silence after bad drift. */
  clear(): void {
    this.frames = [];
    this.lastArrivalAt = null;
    this.jitterMs = 0;
    this.targetMs = this.nominalMs;
  }

  get depth(): number {
    return this.frames.length;
  }

  get depthMs(): number {
    return this.frames.length * AUDIO_FRAME_DURATION_MS;
  }

  /** H15: jitter is only exposed once an arrival interval has been observed. */
  observedJitterMs(): Measurement<number> {
    if (this.lastArrivalAt === null) {
      return notExposed("No inter-arrival interval has been observed on this track.");
    }
    return measured(this.jitterMs);
  }

  private retarget(): void {
    this.targetMs = clamp(
      Math.round(this.nominalMs + this.jitterMs * 2),
      this.minimumMs,
      this.maximumMs,
    );
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
