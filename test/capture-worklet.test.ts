import { describe, expect, it } from "vitest";
import captureCode from "../public/audio/capture-worklet.js?raw";

function createCaptureWorklet(onMessage?: (data: unknown) => void) {
  const Processor = class {
    port = {
      onmessage: null,
      postMessage: (data: unknown) => {
        onMessage?.(data);
      },
    };
  };
  const Capture = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "currentFrame",
    "sampleRate",
    `${captureCode}; return RealFabricCapture;`,
  )(Processor, () => {}, 0, 48_000);
  return new Capture();
}

describe("Standards §6 — RealFabricCapture worklet", () => {
  it("frames mono input render quanta into exact 960-sample frames", () => {
    const received: Array<{ buffer: ArrayBuffer; timestamp: number; droppedFrames: number }> = [];
    const worklet = createCaptureWorklet((msg) => {
      received.push(msg as { buffer: ArrayBuffer; timestamp: number; droppedFrames: number });
    });

    const quantum = new Float32Array(128).fill(0.5);
    // 960 / 128 = 7.5 quanta needed per frame. 15 quanta = 2 full frames (1920 samples).
    for (let i = 0; i < 15; i += 1) {
      worklet.process([[quantum]], []);
    }

    expect(received.length).toBe(2);
    const item0 = received[0];
    expect(item0).toBeDefined();
    if (!item0) return;
    expect(item0.buffer.byteLength).toBe(960 * 4);
    const frame0 = new Float32Array(item0.buffer);
    expect(frame0[0]).toBe(0.5);
    expect(frame0[959]).toBe(0.5);
  });

  it("downmixes multi-channel input quanta by averaging channels", () => {
    const received: Array<{ buffer: ArrayBuffer; timestamp: number; droppedFrames: number }> = [];
    const worklet = createCaptureWorklet((msg) => {
      received.push(msg as { buffer: ArrayBuffer; timestamp: number; droppedFrames: number });
    });

    const ch0 = new Float32Array(128).fill(0.2);
    const ch1 = new Float32Array(128).fill(0.8);

    for (let i = 0; i < 15; i += 1) {
      worklet.process([[ch0, ch1]], []);
    }

    expect(received.length).toBe(2);
    const item0 = received[0];
    expect(item0).toBeDefined();
    if (!item0) return;
    const frame0 = new Float32Array(item0.buffer);
    const sample0 = frame0[0] ?? 0;
    const sample959 = frame0[959] ?? 0;
    // Expected average: (0.2 + 0.8) / 2 = 0.5
    expect(Math.abs(sample0 - 0.5)).toBeLessThan(1e-6);
    expect(Math.abs(sample959 - 0.5)).toBeLessThan(1e-6);
  });

  it("measures performance across 50,000 quanta for mono and stereo streams", () => {
    const worklet = createCaptureWorklet((msg) => {
      // Recycle buffer immediately so pool is never exhausted
      const m = msg as { buffer: ArrayBuffer };
      worklet.handle({ type: "recycle", buffer: m.buffer });
    });

    const monoQuantum = [new Float32Array(128).fill(0.25)];
    const stereoQuantum = [new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.75)];

    const runs = 50_000;
    const start = performance.now();
    for (let i = 0; i < runs; i += 1) {
      worklet.process(i % 2 === 0 ? [monoQuantum] : [stereoQuantum], []);
    }
    const elapsed = performance.now() - start;
    console.log(`[BENCHMARK] RealFabricCapture.process (${runs} quanta): ${elapsed.toFixed(2)} ms`);
    expect(elapsed).toBeGreaterThan(0);
  });
});
