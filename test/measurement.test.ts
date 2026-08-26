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
  describe("formatCount", () => {
    it("formats exposed integer count using en-GB locale formatting", () => {
      expect(formatCount(measured(0))).toBe("0");
      expect(formatCount(measured(5))).toBe("5");
      expect(formatCount(measured(1234567))).toBe("1,234,567");
      expect(formatCount(measured(-1000))).toBe("-1,000");
    });

    it("formats exposed decimal count using en-GB locale formatting", () => {
      expect(formatCount(measured(1234.56))).toBe("1,234.56");
    });

    it("returns 'Not exposed' when count measurement is not exposed", () => {
      expect(formatCount(notExposed("no session attempted"))).toBe(NOT_EXPOSED);
      expect(formatCount(notExposed("no data"))).toBe("Not exposed");
    });
  });

  describe("formatMeasurement", () => {
    it("uses default String formatter when no custom format function is provided", () => {
      expect(formatMeasurement(measured(42))).toBe("42");
      expect(formatMeasurement(measured(true))).toBe("true");
    });

    it("applies custom format function when measurement is exposed", () => {
      expect(formatMeasurement(measured("hello"), (v) => v.toUpperCase())).toBe("HELLO");
    });

    it("returns 'Not exposed' when measurement is not exposed regardless of format function", () => {
      expect(formatMeasurement(notExposed<string>("unavailable"), (v) => v.toUpperCase())).toBe(
        NOT_EXPOSED,
      );
    });
  });

  describe("formatMilliseconds", () => {
    it("formats rounded milliseconds for exposed measurements", () => {
      expect(formatMilliseconds(measured(12.4))).toBe("12 ms");
      expect(formatMilliseconds(measured(12.6))).toBe("13 ms");
      expect(formatMilliseconds(measured(0))).toBe("0 ms");
    });

    it("returns 'Not exposed' for unexposed milliseconds measurements", () => {
      expect(formatMilliseconds(notExposed("not measured"))).toBe(NOT_EXPOSED);
    });
  });

  describe("formatRate", () => {
    it("formats rate with one decimal place and specified unit", () => {
      expect(formatRate(measured(12.345), "objs/s")).toBe("12.3 objs/s");
      expect(formatRate(measured(0), "fps")).toBe("0.0 fps");
    });

    it("returns 'Not exposed' for unexposed rate measurements", () => {
      expect(formatRate(notExposed("no rate available"), "objs/s")).toBe(NOT_EXPOSED);
    });
  });

  describe("measured & notExposed factories", () => {
    it("creates an exposed measurement object", () => {
      const m = measured(100);
      expect(m).toEqual({ exposed: true, value: 100 });
    });

    it("creates an unexposed measurement object with reason", () => {
      const m = notExposed("reason for no data");
      expect(m).toEqual({ exposed: false, reason: "reason for no data" });
    });
  });

  describe("fromNullable", () => {
    it("returns exposed measurement for non-null and non-undefined primitive values", () => {
      expect(fromNullable(10, "missing")).toEqual({ exposed: true, value: 10 });
      expect(fromNullable("str", "missing")).toEqual({ exposed: true, value: "str" });
      expect(fromNullable("", "missing")).toEqual({ exposed: true, value: "" });
      expect(fromNullable(0, "missing")).toEqual({ exposed: true, value: 0 });
      expect(fromNullable(false, "missing")).toEqual({ exposed: true, value: false });
      expect(fromNullable(true, "missing")).toEqual({ exposed: true, value: true });
    });

    it("returns exposed measurement for complex objects and arrays", () => {
      const obj = { id: "test-id", count: 42 };
      const arr = [1, 2, 3];
      expect(fromNullable(obj, "missing object")).toEqual({ exposed: true, value: obj });
      expect(fromNullable(arr, "missing array")).toEqual({ exposed: true, value: arr });
    });

    it("returns unexposed measurement with specified reason when value is null or undefined", () => {
      expect(fromNullable(null, "value is null")).toEqual({
        exposed: false,
        reason: "value is null",
      });
      expect(fromNullable(undefined, "value is undefined")).toEqual({
        exposed: false,
        reason: "value is undefined",
      });
    });

    it("correctly narrows NonNullable type when exposed", () => {
      const maybeValue: number | null = 42;
      const result = fromNullable(maybeValue, "no value");
      if (result.exposed) {
        const value: number = result.value;
        expect(value).toBe(42);
      } else {
        expect.unreachable("Expected measurement to be exposed");
      }
    });
  });

  describe("valueOr", () => {
    it("returns the measurement value when exposed", () => {
      expect(valueOr(measured(50), 0)).toBe(50);
    });

    it("returns the fallback value when not exposed", () => {
      expect(valueOr(notExposed<number>("no data"), 100)).toBe(100);
    });
  });
});
