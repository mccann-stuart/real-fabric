/**
 * H7 and FR3: when the client cannot sustain the active load it degrades in a
 * fixed order, announcing each step. It never refuses a join to avoid
 * degrading, and it never degrades silently.
 *
 * Capacity is therefore a measurement, not a configured cap — the ladder is
 * what makes that honest rather than merely permissive.
 */

export type DegradationStep = 0 | 1 | 2 | 3;

/** Silence beyond this releases a track's decoder, rebuilt on the next object. */
export const DECODER_RELEASE_SILENCE_MS = 30_000;

export interface LadderInput {
  /** Tracks currently producing audio. DTX means silent tracks cost nothing. */
  activeSpeakers: number;
  /** Worst per-track buffer depth in milliseconds. */
  worstBufferMs: number;
  /** Underruns observed across all tracks in the last window. */
  underrunsInWindow: number;
  /** Subscribed tracks, and when each last carried audio. */
  tracks: ReadonlyArray<{ trackId: string; lastActiveAt: number }>;
  now: number;
}

export interface LadderState {
  step: DegradationStep;
  /** Nominal jitter target the buffers should adopt. */
  nominalBufferMs: number;
  /** Tracks whose decoders should be released, rebuilt on first object. */
  releasedDecoders: string[];
  /** Tracks unsubscribed as the last resort, least recently active first. */
  unsubscribed: string[];
  /** Exactly the copy the specification requires, or null below step three. */
  announcement: string | null;
}

const NOMINAL_BY_STEP: Record<DegradationStep, number> = {
  0: 60,
  1: 120,
  2: 120,
  3: 120,
};

/** Step three unsubscribes in blocks rather than one track at a time. */
const UNSUBSCRIBE_BLOCK = 2;

export class DegradationLadder {
  private step: DegradationStep = 0;
  private unsubscribedTrackIds: string[] = [];
  /** Hysteresis: recover only after the load has genuinely eased. */
  private healthyWindows = 0;

  evaluate(input: LadderInput): LadderState {
    const strained =
      input.underrunsInWindow > 3 || input.worstBufferMs >= 180 || input.activeSpeakers > 8;

    if (strained) {
      this.healthyWindows = 0;
      if (this.step < 3) this.step = (this.step + 1) as DegradationStep;
    } else {
      this.healthyWindows += 1;
      // Recover one rung at a time, and only after three quiet windows, so the
      // ladder does not flap in front of an audience.
      if (this.healthyWindows >= 3 && this.step > 0) {
        this.step = (this.step - 1) as DegradationStep;
        this.healthyWindows = 0;
        if (this.step < 3) this.unsubscribedTrackIds = [];
      }
    }

    const releasedDecoders =
      this.step >= 2
        ? input.tracks
            .filter((track) => input.now - track.lastActiveAt >= DECODER_RELEASE_SILENCE_MS)
            .map((track) => track.trackId)
        : [];

    if (this.step >= 3) {
      const candidates = input.tracks
        .filter((track) => !this.unsubscribedTrackIds.includes(track.trackId))
        .sort((left, right) => left.lastActiveAt - right.lastActiveAt)
        .slice(0, UNSUBSCRIBE_BLOCK)
        .map((track) => track.trackId);
      this.unsubscribedTrackIds = [...this.unsubscribedTrackIds, ...candidates];
    }

    return {
      step: this.step,
      nominalBufferMs: NOMINAL_BY_STEP[this.step],
      releasedDecoders,
      unsubscribed: [...this.unsubscribedTrackIds],
      announcement: describeStep(this.step, this.unsubscribedTrackIds.length),
    };
  }

  reset(): void {
    this.step = 0;
    this.unsubscribedTrackIds = [];
    this.healthyWindows = 0;
  }
}

/**
 * Step three's wording is fixed by the specification. The earlier rungs are
 * announced too, because "never degrade silently" applies to all of them.
 */
export function describeStep(step: DegradationStep, pausedCount: number): string | null {
  switch (step) {
    case 0:
      return null;
    case 1:
      return "Buffer raised — protecting audio on a strained connection";
    case 2:
      return "Decoders released for participants silent beyond 30 seconds — rebuilt on their next object";
    case 3: {
      const participant = pausedCount === 1 ? "participant" : "participants";
      return `audio paused for ${pausedCount} ${participant} — capacity protection engaged`;
    }
  }
}
