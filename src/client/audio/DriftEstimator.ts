import { type Measurement, measured, notExposed } from "../../shared/measurement";

/**
 * FR3 clock drift: estimate the skew between a sender's media clock and the
 * local AudioContext clock, and correct it by slow resampling.
 *
 * The estimator is deliberately conservative. Correcting quickly is audible;
 * the specification asks for continuous slow correction, and a track whose
 * skew exceeds the correction range is reported rather than fought.
 */

/**
 * §10.6: skew beyond 5% is `drift_uncorrectable` and the track is rebuilt
 * instead of resampled, because a correction that large is audible.
 */
export const MAXIMUM_CORRECTION_RATIO = 1.05;
export const MINIMUM_CORRECTION_RATIO = 0.95;
/**
 * Applied per correction step. The specification asks for continuous slow
 * correction, so a large estimated skew is walked towards rather than jumped
 * to, even while it stays inside the correctable range.
 */
export const MAXIMUM_STEP_RATIO = 1.02;
export const MINIMUM_STEP_RATIO = 0.98;
/** Ignore the first samples; a cold buffer's timing says nothing about drift. */
const WARMUP_OBSERVATIONS = 25;
/** Smoothing on the parts-per-million estimate. */
const SMOOTHING = 32;

export interface DriftCorrection {
  at: number;
  trackId: string;
  ratio: number;
  /** Parts per million of estimated skew at the time of correction. */
  skewPpm: number;
}

export type DriftHealth = "converged" | "correcting" | "beyond_range";

export class DriftEstimator {
  private observations = 0;
  private smoothedSkewPpm = 0;
  private firstMediaTimestampMs: number | null = null;
  private firstLocalTimeMs: number | null = null;
  private lastCorrection: DriftCorrection | null = null;

  constructor(readonly trackId: string) {}

  /**
   * `mediaTimestampMs` comes from the sender's clock via the object header;
   * `localTimeMs` is the local AudioContext clock at arrival. Their divergence
   * over time is the skew.
   */
  observe(mediaTimestampMs: number, localTimeMs: number): void {
    if (this.firstMediaTimestampMs === null || this.firstLocalTimeMs === null) {
      this.firstMediaTimestampMs = mediaTimestampMs;
      this.firstLocalTimeMs = localTimeMs;
      this.observations = 1;
      return;
    }

    const mediaElapsed = mediaTimestampMs - this.firstMediaTimestampMs;
    const localElapsed = localTimeMs - this.firstLocalTimeMs;
    this.observations += 1;
    if (mediaElapsed <= 0) return;

    // Positive skew: the sender's clock is running slow relative to ours, so
    // we must read its buffer more slowly to avoid draining it.
    const skewPpm = ((localElapsed - mediaElapsed) / mediaElapsed) * 1_000_000;
    this.smoothedSkewPpm += (skewPpm - this.smoothedSkewPpm) / SMOOTHING;
  }

  /**
   * Ratio to hand the mixing worklet. 1 means no correction.
   *
   * Clamped to the per-step bound, not the correctable range: a track that is
   * 4% out is corrected 2% at a time so the resampling stays inaudible, and it
   * converges over a few seconds rather than in one audible jump.
   */
  correctionRatio(): number {
    if (this.observations < WARMUP_OBSERVATIONS) return 1;
    const raw = 1 + this.smoothedSkewPpm / 1_000_000;
    return clamp(raw, MINIMUM_STEP_RATIO, MAXIMUM_STEP_RATIO);
  }

  health(): DriftHealth {
    if (this.observations < WARMUP_OBSERVATIONS) return "converged";
    const raw = 1 + this.smoothedSkewPpm / 1_000_000;
    if (raw > MAXIMUM_CORRECTION_RATIO || raw < MINIMUM_CORRECTION_RATIO) return "beyond_range";
    return Math.abs(this.smoothedSkewPpm) > 50 ? "correcting" : "converged";
  }

  /** H15: no estimate before warm-up reads as zero drift. */
  skewPpm(): Measurement<number> {
    if (this.observations < WARMUP_OBSERVATIONS) {
      return notExposed("Fewer arrivals than the drift estimator needs to converge.");
    }
    return measured(this.smoothedSkewPpm);
  }

  /** Records the correction actually applied, for the inspector's log. */
  recordCorrection(at: number): DriftCorrection | null {
    const ratio = this.correctionRatio();
    if (ratio === 1) return null;
    if (this.lastCorrection && Math.abs(this.lastCorrection.ratio - ratio) < 0.0002) return null;
    this.lastCorrection = {
      at,
      trackId: this.trackId,
      ratio,
      skewPpm: this.smoothedSkewPpm,
    };
    return this.lastCorrection;
  }

  /** FR3: rebuild this track's buffer at the next silence. */
  reset(): void {
    this.observations = 0;
    this.smoothedSkewPpm = 0;
    this.firstMediaTimestampMs = null;
    this.firstLocalTimeMs = null;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
