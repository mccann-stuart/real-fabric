import { describe, expect, it } from "vitest";
import { AdaptiveJitterBuffer } from "../src/client/audio/AdaptiveJitterBuffer";

describe("AdaptiveJitterBuffer", () => {
  it("orders frames and releases them only after the target delay", () => {
    const buffer = new AdaptiveJitterBuffer<string>();
    buffer.push({ sequence: 2, groupId: 1, receivedAt: 1_020, value: "two" });
    buffer.push({ sequence: 1, groupId: 1, receivedAt: 1_000, value: "one" });

    expect(buffer.pull(1_040)).toBeUndefined();
    expect(buffer.pull(1_100)).toBe("one");
    expect(buffer.pull(1_120)).toBe("two");
  });

  it("bounds stale frames and records drops", () => {
    const buffer = new AdaptiveJitterBuffer<string>();
    buffer.push({ sequence: 1, groupId: 1, receivedAt: 1_000, value: "stale" });
    buffer.push({ sequence: 2, groupId: 1, receivedAt: 1_300, value: "current" });

    expect(buffer.lateDrops).toBe(1);
    expect(buffer.depth).toBe(1);
    expect(buffer.targetMs).toBeLessThanOrEqual(200);
  });

  it("handles duplicate sequences and out-of-order frames correctly", () => {
    const buffer = new AdaptiveJitterBuffer<string>();
    buffer.push({ sequence: 3, groupId: 1, receivedAt: 1_040, value: "three" });
    buffer.push({ sequence: 1, groupId: 1, receivedAt: 1_000, value: "one" });
    buffer.push({ sequence: 2, groupId: 1, receivedAt: 1_020, value: "two" });
    // Duplicate frame push
    buffer.push({ sequence: 2, groupId: 1, receivedAt: 1_025, value: "two-duplicate" });

    expect(buffer.depth).toBe(3);
    expect(buffer.pull(1_120)).toBe("one");
    expect(buffer.pull(1_120)).toBe("two");
    expect(buffer.pull(1_120)).toBe("three");
  });

  it("bounds maximum buffered frames under media frame burst (SEC-10)", () => {
    const buffer = new AdaptiveJitterBuffer<string>();
    // Push 70 frames in a burst (capacity cap is 50)
    for (let i = 1; i <= 70; i += 1) {
      buffer.push({ sequence: i, groupId: 1, receivedAt: 1_000 + i, value: `frame-${i}` });
    }

    expect(buffer.depth).toBe(50);
    expect(buffer.lateDrops).toBe(20);
  });
});
