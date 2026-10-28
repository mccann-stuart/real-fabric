import { describe, expect, it } from "vitest";
import captureCode from "../public/audio/capture-worklet.js?raw";

function createCaptureProcessor() {
  const Processor = class {
    port = { onmessage: null, postMessage: () => {} };
  };
  const Capture = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "currentFrame",
    "sampleRate",
    `${captureCode}; return RealFabricCapture;`,
  )(Processor, () => {}, 0, 48000);
  return new Capture();
}

describe("capture-worklet processing and benchmark", () => {
  it("aggregates mono input render quanta into exact 960-sample frames", () => {
    const processor = createCaptureProcessor();
    const messages: Array<{ type: string; buffer: ArrayBuffer }> = [];
    processor.port.postMessage = (msg: unknown) => {
      messages.push(msg as { type: string; buffer: ArrayBuffer });
    };

    for (let q = 0; q < 15; q += 1) {
      const quantum = new Float32Array(128).fill(0.5);
      expect(processor.process([[quantum]], [])).toBe(true);
    }

    // 15 quanta * 128 = 1920 samples = exactly 2 x 960-sample frames emitted
    expect(messages).toHaveLength(2);
    expect(messages[0]?.type).toBe("frame");
    const frame0 = new Float32Array(messages[0]!.buffer);
    expect(frame0).toHaveLength(960);
    expect(frame0[0]).toBeCloseTo(0.5);
    expect(frame0[959]).toBeCloseTo(0.5);
  });

  it("downmixes multi-channel input render quanta correctly", () => {
    const processor = createCaptureProcessor();
    const messages: Array<{ type: string; buffer: ArrayBuffer }> = [];
    processor.port.postMessage = (msg: unknown) => {
      messages.push(msg as { type: string; buffer: ArrayBuffer });
    };

    for (let q = 0; q < 15; q += 1) {
      const ch1 = new Float32Array(128).fill(0.4);
      const ch2 = new Float32Array(128).fill(0.8);
      expect(processor.process([[ch1, ch2]], [])).toBe(true);
    }

    expect(messages).toHaveLength(2);
    const frame0 = new Float32Array(messages[0]!.buffer);
    // (0.4 + 0.8) / 2 = 0.6
    expect(frame0[0]).toBeCloseTo(0.6);
  });

  it("measures capture-worklet process performance over 100,000 mono render quanta", () => {
    const processor = createCaptureProcessor();
    processor.port.postMessage = (msg: unknown) => {
      // Recycle buffer back to keep available pool full
      const m = msg as { buffer: ArrayBuffer };
      processor.handle({ type: "recycle", buffer: m.buffer });
    };

    const inputData = [new Float32Array(128).fill(0.25)];
    const iterations = 100_000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      processor.process([inputData], []);
    }
    const end = performance.now();
    const duration = end - start;

    console.log(
      `[BENCHMARK] RealFabricCapture.process (${iterations} mono quanta): ${duration.toFixed(2)} ms`,
    );
    expect(duration).toBeGreaterThan(0);
  });
});
