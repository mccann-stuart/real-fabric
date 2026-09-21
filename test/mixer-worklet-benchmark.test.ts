import { describe, expect, it } from "vitest";

const RING_SAMPLES = 48_000;

class TrackBuffer {
  ring = new Float32Array(RING_SAMPLES);
  writeIndex = 0;
  readIndex = 0;
  available = 0;
  ratio = 1;
  underruns = 0;
  consecutiveUnderrunQuanta = 0;
  everWritten = false;
  active = false;
  awaitingActiveSamples = false;
  starved = false;

  write(samples: Float32Array): void {
    this.everWritten = true;
    this.awaitingActiveSamples = false;
    const len = samples.length;
    if (len === 0) return;
    const firstChunk = Math.min(len, RING_SAMPLES - this.writeIndex);
    this.ring.set(samples.subarray(0, firstChunk), this.writeIndex);
    if (len > firstChunk) {
      this.ring.set(samples.subarray(firstChunk), 0);
    }
    this.writeIndex = (this.writeIndex + len) % RING_SAMPLES;
    this.available = Math.min(RING_SAMPLES, this.available + len);
  }

  read(): number | null {
    if (this.available < 2) return null;
    const base = Math.floor(this.readIndex);
    const fraction = this.readIndex - base;
    const first = this.ring[base % RING_SAMPLES] ?? 0;
    const second = this.ring[(base + 1) % RING_SAMPLES] ?? 0;
    const value = first + (second - first) * fraction;

    this.readIndex += this.ratio;
    this.available -= Math.floor(this.readIndex) - base;
    if (this.readIndex >= RING_SAMPLES) this.readIndex -= RING_SAMPLES;
    return value;
  }
}

describe("Mixer Worklet TrackBuffer Benchmark & Correctness", () => {
  it("correctly handles sequential and wrap-around ring buffer writes", () => {
    const buffer = new TrackBuffer();

    const frame1 = new Float32Array(960);
    for (let i = 0; i < 960; i++) frame1[i] = i + 1;

    buffer.write(frame1);
    expect(buffer.writeIndex).toBe(960);
    expect(buffer.available).toBe(960);
    for (let i = 0; i < 960; i++) {
      expect(buffer.ring[i]).toBe(i + 1);
    }

    // Set writeIndex near boundary (47,500 out of 48,000) to test wrap-around
    buffer.writeIndex = 47500;
    const frame2 = new Float32Array(960);
    for (let i = 0; i < 960; i++) frame2[i] = (i + 1) * 2;

    buffer.write(frame2);
    // 47500 + 960 = 48460 -> 48460 % 48000 = 460
    expect(buffer.writeIndex).toBe(460);
    expect(buffer.available).toBe(1920);

    // Verify first chunk (0..499) at end of ring buffer (47500..47999)
    for (let i = 0; i < 500; i++) {
      expect(buffer.ring[47500 + i]).toBe((i + 1) * 2);
    }
    // Verify second chunk (500..959) at start of ring buffer (0..459)
    for (let i = 0; i < 460; i++) {
      expect(buffer.ring[i]).toBe((500 + i + 1) * 2);
    }
  });

  it("measures write performance over 50,000 frames (~16 minutes of 20ms audio)", () => {
    const buffer = new TrackBuffer();
    const frameCount = 50_000;
    const testFrame = new Float32Array(960);
    for (let i = 0; i < 960; i++) testFrame[i] = Math.random();

    const start = performance.now();
    for (let i = 0; i < frameCount; i++) {
      buffer.write(testFrame);
    }
    const duration = performance.now() - start;

    expect(buffer.available).toBe(48000);
    console.log(`[BENCHMARK] TrackBuffer.write (${frameCount} frames): ${duration.toFixed(2)} ms`);
  });
});
