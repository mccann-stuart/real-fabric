/**
 * H6 barge-in needs the moment a human starts speaking, locally and fast.
 *
 * The 300 ms budget is measured from human onset, so onset detection sits on
 * the capture path rather than waiting for a server round trip. This is
 * deliberately a simple energy gate with hysteresis: a full VAD would add
 * latency to the one measurement the specification pins.
 */

export interface VoiceActivityOptions {
  /** Root-mean-square above which a quantum counts as speech. */
  onsetThreshold?: number;
  /** Lower threshold for release, so a steady voice does not chatter. */
  releaseThreshold?: number;
  /** Consecutive speech quanta required before onset fires. */
  onsetQuanta?: number;
  /** Consecutive quiet quanta required before release fires. */
  releaseQuanta?: number;
}

export type VoiceActivityEvent = "onset" | "release" | null;

export class VoiceActivityDetector {
  private readonly onsetThreshold: number;
  private readonly releaseThreshold: number;
  private readonly onsetQuanta: number;
  private readonly releaseQuanta: number;
  private speaking = false;
  private aboveRun = 0;
  private belowRun = 0;
  private lastRms = 0;

  constructor(options: VoiceActivityOptions = {}) {
    this.onsetThreshold = options.onsetThreshold ?? 0.045;
    this.releaseThreshold = options.releaseThreshold ?? 0.02;
    this.onsetQuanta = options.onsetQuanta ?? 2;
    this.releaseQuanta = options.releaseQuanta ?? 12;
  }

  /** Feed one capture quantum. Returns the transition, if any. */
  observe(samples: Float32Array): VoiceActivityEvent {
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index] ?? 0;
      sum += sample * sample;
    }
    this.lastRms = samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);

    if (this.speaking) {
      if (this.lastRms < this.releaseThreshold) {
        this.belowRun += 1;
        this.aboveRun = 0;
        if (this.belowRun >= this.releaseQuanta) {
          this.speaking = false;
          this.belowRun = 0;
          return "release";
        }
      } else {
        this.belowRun = 0;
      }
      return null;
    }

    if (this.lastRms >= this.onsetThreshold) {
      this.aboveRun += 1;
      this.belowRun = 0;
      if (this.aboveRun >= this.onsetQuanta) {
        this.speaking = true;
        this.aboveRun = 0;
        return "onset";
      }
    } else {
      this.aboveRun = 0;
    }
    return null;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Live level for the participant card, 0 to 1. */
  get level(): number {
    return Math.min(1, this.lastRms / 0.3);
  }

  reset(): void {
    this.speaking = false;
    this.aboveRun = 0;
    this.belowRun = 0;
    this.lastRms = 0;
  }
}
