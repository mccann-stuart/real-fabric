import { describe, expect, it } from "vitest";
import {
  AdaptiveJitterBuffer,
  MAXIMUM_BUFFERED_FRAMES,
} from "../src/client/audio/AdaptiveJitterBuffer";

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

  it("bounds buffered frames during a media burst", () => {
    const buffer = new AdaptiveJitterBuffer<string>();
    for (let sequence = 0; sequence < MAXIMUM_BUFFERED_FRAMES + 10; sequence += 1) {
      buffer.push({
        sequence,
        groupId: 1,
        receivedAt: 1_000,
        value: `frame-${sequence}`,
      });
    }

    expect(buffer.depth).toBe(MAXIMUM_BUFFERED_FRAMES);
    expect(buffer.lateDrops).toBe(10);
  });
});
