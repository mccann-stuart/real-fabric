import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatMilliseconds,
  formatRate,
  fromNullable,
  measured,
  NOT_EXPOSED,
  notExposed,
  valueOr,
} from "../src/shared/measurement";

describe("valueOr", () => {
  it("returns the measured value when measurement is exposed", () => {
    expect(valueOr(measured(42), 0)).toBe(42);
    expect(valueOr(measured("hello"), "fallback")).toBe("hello");
    expect(valueOr(measured(true), false)).toBe(true);
    expect(valueOr(measured({ key: "val" }), { key: "fallback" })).toEqual({ key: "val" });
  });

  it("handles falsy exposed values correctly", () => {
    expect(valueOr(measured(0), 100)).toBe(0);
    expect(valueOr(measured(""), "fallback")).toBe("");
    expect(valueOr(measured(false), true)).toBe(false);
    expect(valueOr(measured(null), "fallback")).toBeNull();
  });

  it("returns fallback value when measurement is not exposed", () => {
    const unexposed = notExposed<number>("No session attempted");
    expect(valueOr(unexposed, 42)).toBe(42);

    const unexposedString = notExposed<string>("Audio hardware unavailable");
    expect(valueOr(unexposedString, "default")).toBe("default");

    const unexposedBool = notExposed<boolean>("Uncertain state");
    expect(valueOr(unexposedBool, false)).toBe(false);
  });
});

describe("fromNullable", () => {
  it("returns measured measurement when value is present", () => {
    const resNum = fromNullable(123, "Reason");
    expect(resNum).toEqual({ exposed: true, value: 123 });

    const resStr = fromNullable("active", "Reason");
    expect(resStr).toEqual({ exposed: true, value: "active" });

    const resBool = fromNullable(false, "Reason");
    expect(resBool).toEqual({ exposed: true, value: false });
  });

  it("returns notExposed measurement with reason when value is null or undefined", () => {
    const resNull = fromNullable(null, "No sensor data");
    expect(resNull).toEqual({ exposed: false, reason: "No sensor data" });

    const resUndefined = fromNullable(undefined, "Missing telemetry");
    expect(resUndefined).toEqual({ exposed: false, reason: "Missing telemetry" });
  });
});

describe("format helpers", () => {
  it("formatMilliseconds formats rounded ms for exposed values and NOT_EXPOSED for unexposed", () => {
    expect(formatMilliseconds(measured(12.6))).toBe("13 ms");
    expect(formatMilliseconds(measured(10.2))).toBe("10 ms");
    expect(formatMilliseconds(notExposed("no data"))).toBe(NOT_EXPOSED);
  });

  it("formatCount formats count using locale string for exposed values and NOT_EXPOSED for unexposed", () => {
    expect(formatCount(measured(1000))).toBe("1,000");
    expect(formatCount(notExposed("no data"))).toBe(NOT_EXPOSED);
  });

  it("formatRate formats rate with given unit for exposed values and NOT_EXPOSED for unexposed", () => {
    expect(formatRate(measured(15.42), "kbps")).toBe("15.4 kbps");
    expect(formatRate(notExposed("no data"), "fps")).toBe(NOT_EXPOSED);
  });
});
