import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatMeasurement,
  formatMilliseconds,
  formatRate,
  fromNullable,
  measured,
  NOT_EXPOSED,
  notExposed,
  valueOr,
} from "../src/shared/measurement";

describe("measurement formatting and utilities", () => {
  describe("formatRate", () => {
    it("formats exposed rate values with 1 decimal place and unit", () => {
      expect(formatRate(measured(12.345), "fps")).toBe("12.3 fps");
      expect(formatRate(measured(50), "kB/s")).toBe("50.0 kB/s");
      expect(formatRate(measured(0), "msg/s")).toBe("0.0 msg/s");
      expect(formatRate(measured(-3.16), "Hz")).toBe("-3.2 Hz");
    });

    it("returns 'Not exposed' when measurement is unexposed", () => {
      expect(formatRate(notExposed<number>("relay unobservable"), "fps")).toBe(NOT_EXPOSED);
    });
  });

  describe("formatMeasurement", () => {
    it("formats exposed values with custom formatter or default String", () => {
      expect(formatMeasurement(measured(42))).toBe("42");
      expect(formatMeasurement(measured("hello"), (v) => v.toUpperCase())).toBe("HELLO");
    });

    it("returns 'Not exposed' for unexposed values", () => {
      expect(formatMeasurement(notExposed<string>("hidden"))).toBe(NOT_EXPOSED);
    });
  });

  describe("formatMilliseconds", () => {
    it("formats exposed milliseconds rounded to whole number", () => {
      expect(formatMilliseconds(measured(12.6))).toBe("13 ms");
      expect(formatMilliseconds(measured(12.4))).toBe("12 ms");
      expect(formatMilliseconds(measured(0))).toBe("0 ms");
    });

    it("returns 'Not exposed' for unexposed milliseconds", () => {
      expect(formatMilliseconds(notExposed<number>("no RTT"))).toBe(NOT_EXPOSED);
    });
  });

  describe("formatCount", () => {
    it("formats count using UK English locale", () => {
      expect(formatCount(measured(1234567))).toBe("1,234,567");
      expect(formatCount(measured(0))).toBe("0");
    });

    it("returns 'Not exposed' for unexposed counts", () => {
      expect(formatCount(notExposed<number>("untracked"))).toBe(NOT_EXPOSED);
    });
  });

  describe("fromNullable", () => {
    it("wraps non-null and non-undefined values as measured", () => {
      expect(fromNullable(100, "missing")).toEqual(measured(100));
      expect(fromNullable("val", "missing")).toEqual(measured("val"));
      expect(fromNullable(false, "missing")).toEqual(measured(false));
      expect(fromNullable(0, "missing")).toEqual(measured(0));
    });

    it("wraps null or undefined values as notExposed with reason", () => {
      expect(fromNullable(null, "no data")).toEqual(notExposed("no data"));
      expect(fromNullable(undefined, "not found")).toEqual(notExposed("not found"));
    });
  });

  describe("valueOr", () => {
    it("returns measured value if exposed", () => {
      expect(valueOr(measured(42), 0)).toBe(42);
    });

    it("returns fallback value if unexposed", () => {
      expect(valueOr(notExposed<number>("unexposed"), 99)).toBe(99);
    });
  });
});
