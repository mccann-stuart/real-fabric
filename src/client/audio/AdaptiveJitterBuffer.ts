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
/** SEC-10: hard frame cap for adversarial or faulty publisher bursts. */
export const MAXIMUM_BUFFERED_FRAMES = 50;

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

    // Bound both insertion work and retained memory before ordering the frame.
    if (this.frames.length >= MAXIMUM_BUFFERED_FRAMES) {
      this.lateDrops += 1;
      return;
    }

    // ⚡ Bolt Optimization: Audio frames arrive every 20ms (50Hz per track).
    // Maintain sequence order with O(1) fast-path push for in-order arrivals and
    // backward search for out-of-order frames, eliminating O(N log N) sorting per frame.
    const len = this.frames.length;
    const lastFrame = this.frames[len - 1];
    if (len === 0 || (lastFrame && frame.sequence > lastFrame.sequence)) {
      this.frames.push(frame);
    } else {
      let insertIndex = len;
      for (let i = len - 1; i >= 0; i -= 1) {
        const candidate = this.frames[i];
        if (candidate) {
          if (candidate.sequence === frame.sequence) {
            return; // Duplicate frame
          }
          if (candidate.sequence < frame.sequence) {
            insertIndex = i + 1;
            break;
          }
        }
        if (i === 0) {
          insertIndex = 0;
        }
      }
      this.frames.splice(insertIndex, 0, frame);
    }

    if (this.lastArrivalAt !== null) {
      const intervalError = Math.abs(
        frame.receivedAt - this.lastArrivalAt - AUDIO_FRAME_DURATION_MS,
      );
      this.jitterMs += (intervalError - this.jitterMs) / 16;
      this.retarget();
    }
    this.lastArrivalAt = frame.receivedAt;

    // ⚡ Bolt Optimization: Fast-path check for stale frames before looping.
    // If head frame is not stale, no frame is stale in ordered arrival, eliminating array compaction overhead.
    const staleBefore = frame.receivedAt - this.maximumMs;
    const firstFrame = this.frames[0];
    if (firstFrame && firstFrame.receivedAt < staleBefore) {
      let writeIndex = 0;
      let prunedCount = 0;
      for (let readIndex = 0; readIndex < this.frames.length; readIndex += 1) {
        const candidate = this.frames[readIndex];
        if (candidate && candidate.receivedAt < staleBefore) {
          prunedCount += 1;
        } else if (candidate) {
          if (writeIndex !== readIndex) {
            this.frames[writeIndex] = candidate;
          }
          writeIndex += 1;
        }
      }
      if (prunedCount > 0) {
        this.lateDrops += prunedCount;
        this.frames.length = writeIndex;
      }
    }
  }

  pull(now: number): T | undefined {
    // ⚡ Bolt Optimization: O(1) fast-path head check for standard in-order audio playback (50Hz hot path).
    // Avoids findIndex linear predicate call when oldest frame is ready.
    const head = this.frames[0];
    let index = -1;
    if (head && head.receivedAt <= now - this.targetMs) {
      index = 0;
    } else {
      index = this.frames.findIndex((frame) => frame.receivedAt <= now - this.targetMs);
    }

    if (index < 0) {
      this.underruns += 1;
      // A run of underruns means the target is too tight for this path.
      if (this.underruns % 8 === 0) {
        this.jitterMs += AUDIO_FRAME_DURATION_MS / 2;
        this.retarget();
      }
      return undefined;
    }

    if (index === 0) {
      return this.frames.shift()?.value;
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
    // ⚡ Bolt Optimization: In-place filtering to avoid allocating new array during cancellation.
    let writeIndex = 0;
    for (let readIndex = 0; readIndex < this.frames.length; readIndex += 1) {
      const candidate = this.frames[readIndex];
      if (candidate && candidate.groupId !== groupId) {
        if (writeIndex !== readIndex) {
          this.frames[writeIndex] = candidate;
        }
        writeIndex += 1;
      }
    }
    const dropped = before - writeIndex;
    this.frames.length = writeIndex;
    this.cancelledDrops += dropped;

    // Bound the cancellation memory; groups are monotonic and one second long.
    // ⚡ Bolt Optimization: Loop to find oldest group ID without array spread allocation.
    if (this.cancelledGroups.size > 8) {
      let oldest = Infinity;
      for (const id of this.cancelledGroups) {
        if (id < oldest) {
          oldest = id;
        }
      }
      if (oldest !== Infinity) {
        this.cancelledGroups.delete(oldest);
      }
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
