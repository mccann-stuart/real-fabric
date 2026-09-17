import { describe, expect, it } from "vitest";
import { AdaptiveJitterBuffer, type BufferedFrame } from "../src/client/audio/AdaptiveJitterBuffer";

describe("AdaptiveJitterBuffer Benchmark", () => {
  it("measures push and pull performance under out-of-order and in-order conditions", () => {
    const buffer = new AdaptiveJitterBuffer<string>();
    const iterations = 1_000_000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const seqBase = Math.floor(i / 10) * 10;
      const offset = i % 10 === 0 ? 5 : i % 10 === 5 ? 0 : i % 10;
      const seq = seqBase + offset;

      const frame: BufferedFrame<string> = {
        sequence: seq,
        groupId: 1,
        receivedAt: 1000 + i * 20,
        value: `frame-${seq}`,
      };
      buffer.push(frame);
      if (buffer.depth > 15) {
        buffer.pull(1000 + (i - 10) * 20);
      }
    }
    const end = performance.now();
    const duration = end - start;
    expect(buffer.depth).toBeGreaterThan(0);
    console.log(
      `[BENCHMARK] AdaptiveJitterBuffer push/pull (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
  });
});
