export interface BufferedFrame<T> {
  sequence: number;
  receivedAt: number;
  value: T;
}

export class AdaptiveJitterBuffer<T> {
  readonly minimumMs = 40;
  readonly maximumMs = 200;
  targetMs = 60;
  lateDrops = 0;
  underruns = 0;
  private frames: BufferedFrame<T>[] = [];
  private lastArrivalAt: number | null = null;
  private jitterMs = 0;

  push(frame: BufferedFrame<T>): void {
    if (this.frames.some((candidate) => candidate.sequence === frame.sequence)) return;
    if (this.lastArrivalAt !== null) {
      const intervalError = Math.abs(frame.receivedAt - this.lastArrivalAt - 20);
      this.jitterMs += (intervalError - this.jitterMs) / 16;
      this.targetMs = clamp(Math.round(60 + this.jitterMs * 2), this.minimumMs, this.maximumMs);
    }
    this.lastArrivalAt = frame.receivedAt;
    this.frames.push(frame);
    this.frames.sort((left, right) => left.sequence - right.sequence);
    const staleBefore = frame.receivedAt - this.maximumMs;
    const retained = this.frames.filter((candidate) => candidate.receivedAt >= staleBefore);
    this.lateDrops += this.frames.length - retained.length;
    this.frames = retained;
  }

  pull(now: number): T | undefined {
    const index = this.frames.findIndex((frame) => frame.receivedAt <= now - this.targetMs);
    if (index < 0) {
      this.underruns += 1;
      return undefined;
    }
    return this.frames.splice(index, 1)[0]?.value;
  }

  clear(): void {
    this.frames = [];
  }

  get depth(): number {
    return this.frames.length;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
