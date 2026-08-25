import { MEDIA_SAMPLE_RATE } from "./MixerGraph";

/**
 * §10.5 `audio_behind` and §11.3 deliverable three: when an object is dropped
 * for being late, the gap is concealed rather than played as a hole.
 *
 * Two behaviours, because they solve different problems. A short gap is filled
 * by repeating the last pitch period, which preserves the speaker's pitch and
 * is what makes a single lost frame inaudible. A sustained gap stops repeating
 * — a held pitch period turns robotic within a few frames — and emits comfort
 * noise at the track's own measured noise floor, so the listener hears an open
 * line rather than a dead one.
 */

export const FRAME_SAMPLES = (MEDIA_SAMPLE_RATE / 1_000) * 20;
/** After this many consecutive concealed frames, repetition stops sounding like speech. */
export const COMFORT_NOISE_AFTER_FRAMES = 5;
/** Human pitch range the period search covers, in hertz. */
const MINIMUM_PITCH_HZ = 60;
const MAXIMUM_PITCH_HZ = 400;
/** Coarse search stride. Pitch continuity does not need sample accuracy. */
const SEARCH_DECIMATION = 4;
/** Per-frame gain decay while repeating, so a long gap fades rather than buzzes. */
const REPEAT_DECAY = 0.8;
/** Comfort noise sits below the measured floor; it is presence, not content. */
const COMFORT_NOISE_GAIN = 0.7;
const NOISE_FLOOR_SMOOTHING = 32;

export type ConcealmentKind = "pitch_repeat" | "comfort_noise";

export interface Concealment {
  samples: Float32Array;
  kind: ConcealmentKind;
  /** How many frames have been concealed back to back, including this one. */
  consecutive: number;
}

export class PacketLossConcealer {
  private last: Float32Array | null = null;
  private pitchPeriod: number | null = null;
  private consecutive = 0;
  private noiseFloor = 0;
  private concealedFrames = 0;
  private comfortNoiseFrames = 0;

  /** Called for every genuinely decoded frame. Resets the loss run. */
  observe(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.last = samples.slice();
    // Invalidated rather than recomputed: the period is only needed on loss,
    // and loss is the rare case.
    this.pitchPeriod = null;
    this.consecutive = 0;

    const rms = rootMeanSquare(samples);
    this.noiseFloor +=
      (Math.min(rms, this.noiseFloor || rms) - this.noiseFloor) / NOISE_FLOOR_SMOOTHING;
  }

  /**
   * Produces one frame of concealment. Returns null before any frame has been
   * decoded — there is nothing to conceal at the very start of a track, and
   * inventing noise there would be a fiction.
   */
  conceal(): Concealment | null {
    if (!this.last) return null;
    this.consecutive += 1;
    this.concealedFrames += 1;

    if (this.consecutive > COMFORT_NOISE_AFTER_FRAMES) {
      this.comfortNoiseFrames += 1;
      return {
        samples: this.comfortNoise(),
        kind: "comfort_noise",
        consecutive: this.consecutive,
      };
    }
    return {
      samples: this.pitchRepeat(),
      kind: "pitch_repeat",
      consecutive: this.consecutive,
    };
  }

  get stats(): { concealedFrames: number; comfortNoiseFrames: number; consecutive: number } {
    return {
      concealedFrames: this.concealedFrames,
      comfortNoiseFrames: this.comfortNoiseFrames,
      consecutive: this.consecutive,
    };
  }

  reset(): void {
    this.last = null;
    this.pitchPeriod = null;
    this.consecutive = 0;
    this.noiseFloor = 0;
  }

  /** Repeats the final pitch period, decayed by how long the gap has run. */
  private pitchRepeat(): Float32Array {
    const source = this.last;
    if (!source) return new Float32Array(FRAME_SAMPLES);
    // Computed on the first loss of a run and reused for the rest of it.
    if (this.pitchPeriod === null) this.pitchPeriod = estimatePitchPeriod(source);
    const period = this.pitchPeriod;
    const gain = REPEAT_DECAY ** this.consecutive;
    const output = new Float32Array(FRAME_SAMPLES);
    const tail = source.subarray(Math.max(0, source.length - period));
    if (tail.length === 0) return output;
    for (let index = 0; index < output.length; index += 1) {
      output[index] = (tail[index % tail.length] ?? 0) * gain;
    }
    return output;
  }

  private comfortNoise(): Float32Array {
    const output = new Float32Array(FRAME_SAMPLES);
    const amplitude = this.noiseFloor * COMFORT_NOISE_GAIN;
    if (amplitude <= 0) return output;
    for (let index = 0; index < output.length; index += 1) {
      output[index] = (Math.random() * 2 - 1) * amplitude;
    }
    return output;
  }
}

/**
 * Coarse autocorrelation over the decimated frame. Returns the lag with the
 * strongest self-similarity, falling back to the shortest candidate period when
 * the frame carries no periodic structure (silence, or an unvoiced consonant).
 */
export function estimatePitchPeriod(samples: Float32Array): number {
  const minimumLag = Math.floor(MEDIA_SAMPLE_RATE / MAXIMUM_PITCH_HZ);
  const maximumLag = Math.min(
    Math.floor(MEDIA_SAMPLE_RATE / MINIMUM_PITCH_HZ),
    Math.floor(samples.length / 2),
  );
  if (maximumLag <= minimumLag) return Math.min(minimumLag, samples.length);

  let bestLag = minimumLag;
  let bestScore = -Infinity;
  for (let lag = minimumLag; lag <= maximumLag; lag += SEARCH_DECIMATION) {
    let score = 0;
    for (let index = lag; index < samples.length; index += SEARCH_DECIMATION) {
      score += (samples[index] ?? 0) * (samples[index - lag] ?? 0);
    }
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag;
}

function rootMeanSquare(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}
