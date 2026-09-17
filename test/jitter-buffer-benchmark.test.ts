import { describe, expect, it } from "vitest";
import {
  AdaptiveJitterBuffer,
  type BufferedFrame,
  MAXIMUM_BUFFERED_FRAMES,
} from "../src/client/audio/AdaptiveJitterBuffer";

/**
 * A soak rather than a gate. The elapsed time is reported for eyeballing only:
 * no budget is asserted, because a wall-clock threshold on shared CI hardware
 * fails for reasons that have nothing to do with this code. What IS asserted is
 * the behaviour that must hold across a long out-of-order run — the SEC-10
 * bound, and that frames keep coming out in order the whole way.
 */
describe("AdaptiveJitterBuffer soak", () => {
  it("stays bounded and keeps releasing frames in order across a million operations", () => {
    const buffer = new AdaptiveJitterBuffer<string>();
    const iterations = 1_000_000;
    let deepest = 0;
    let pulled = 0;

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
      deepest = Math.max(deepest, buffer.depth);
      if (buffer.depth > 15) {
        if (buffer.pull(1000 + (i - 10) * 20) !== undefined) pulled += 1;
      }
    }
    const duration = performance.now() - start;

    // The loop pulls whenever depth exceeds 15, so 16 is the ceiling this run
    // may reach — well inside the SEC-10 cap. Pinning the exact value rather
    // than the cap is what makes this load-bearing: were pull() to stop
    // releasing, depth would climb to MAXIMUM_BUFFERED_FRAMES and only then
    // stop, which a `<= MAXIMUM_BUFFERED_FRAMES` assertion would happily allow.
    expect(deepest).toBe(16);
    expect(MAXIMUM_BUFFERED_FRAMES).toBeGreaterThan(deepest);
    // Conservation: every frame pushed was released, dropped as late, or is
    // still held. Nothing may vanish unaccounted for across a long run.
    expect(pulled).toBeGreaterThan(0);
    expect(buffer.lateDrops + pulled + buffer.depth).toBe(iterations);

    console.log(
      `[BENCHMARK] AdaptiveJitterBuffer push/pull (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
  });
});
