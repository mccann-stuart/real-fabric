import { describe, expect, it } from "vitest";
import { AdaptiveJitterBuffer } from "../src/client/audio/AdaptiveJitterBuffer";

describe("AdaptiveJitterBuffer", () => {
  it("orders frames and releases them only after the target delay", () => {
    const buffer = new AdaptiveJitterBuffer<string>();
    buffer.push({ sequence: 2, receivedAt: 1_020, value: "two" });
    buffer.push({ sequence: 1, receivedAt: 1_000, value: "one" });

    expect(buffer.pull(1_040)).toBeUndefined();
    expect(buffer.pull(1_100)).toBe("one");
    expect(buffer.pull(1_120)).toBe("two");
  });

  it("bounds stale frames and records drops", () => {
    const buffer = new AdaptiveJitterBuffer<string>();
    buffer.push({ sequence: 1, receivedAt: 1_000, value: "stale" });
    buffer.push({ sequence: 2, receivedAt: 1_300, value: "current" });

    expect(buffer.lateDrops).toBe(1);
    expect(buffer.depth).toBe(1);
    expect(buffer.targetMs).toBeLessThanOrEqual(200);
  });
});
