import { describe, expect, it } from "vitest";
import {
  generateRandomDisplayName,
  SAFE_DISPLAY_NAME_COUNT,
  safeDisplayNameAt,
} from "../src/client/displayName";

describe("safe display names", () => {
  it("provides exactly 2,000 unique two-word names", () => {
    const names = Array.from({ length: SAFE_DISPLAY_NAME_COUNT }, (_, index) =>
      safeDisplayNameAt(index),
    );

    expect(names).toHaveLength(2_000);
    expect(new Set(names).size).toBe(2_000);
    for (const name of names) expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("generates names only from the curated set", () => {
    const safeNames = new Set(
      Array.from({ length: SAFE_DISPLAY_NAME_COUNT }, (_, index) => safeDisplayNameAt(index)),
    );

    for (let sample = 0; sample < 100; sample += 1) {
      expect(safeNames.has(generateRandomDisplayName())).toBe(true);
    }
  });

  it("rejects indexes outside the curated set", () => {
    expect(() => safeDisplayNameAt(-1)).toThrow(RangeError);
    expect(() => safeDisplayNameAt(SAFE_DISPLAY_NAME_COUNT)).toThrow(RangeError);
  });
});
