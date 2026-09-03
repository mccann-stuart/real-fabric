import { describe, expect, it } from "vitest";
import {
  type HttpError,
  optionalString,
  readJsonObject,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredString,
} from "../src/worker/validation";

describe("request validation", () => {
  describe("requiredEnum", () => {
    const allowedValues = ["alpha", "beta", "gamma"] as const;

    it("returns enum value when field is a valid allowed string", () => {
      expect(requiredEnum({ mode: "alpha" }, "mode", allowedValues)).toBe("alpha");
      expect(requiredEnum({ mode: "beta" }, "mode", allowedValues)).toBe("beta");
      expect(requiredEnum({ mode: "gamma" }, "mode", allowedValues)).toBe("gamma");
    });

    it("throws HttpError 400 invalid_request for missing, non-string, or unallowed values", () => {
      const invalidCases: Array<[string, Record<string, unknown>]> = [
        ["missing field", {}],
        ["null value", { mode: null }],
        ["undefined value", { mode: undefined }],
        ["numeric value", { mode: 123 }],
        ["boolean value", { mode: true }],
        ["object value", { mode: {} }],
        ["array value", { mode: ["alpha"] }],
        ["unallowed string value", { mode: "delta" }],
        ["case mismatch string value", { mode: "ALPHA" }],
      ];

      for (const [description, body] of invalidCases) {
        expect(
          () => requiredEnum(body, "mode", allowedValues),
          `failed for case: ${description}`,
        ).toThrowError();
        try {
          requiredEnum(body, "mode", allowedValues);
        } catch (error) {
          expect(error).toMatchObject({
            status: 400,
            code: "invalid_request",
            message: "Field 'mode' must be one of: alpha, beta, gamma.",
          } satisfies Partial<HttpError>);
        }
      }
    });
  });

  describe("optionalString", () => {
    it("returns undefined when field is missing or undefined", () => {
      expect(optionalString({}, "rejoinToken", 10)).toBeUndefined();
      expect(optionalString({ rejoinToken: undefined }, "rejoinToken", 10)).toBeUndefined();
    });

    it("returns the string when field is a valid string within maximumLength", () => {
      expect(optionalString({ wakeName: "" }, "wakeName", 10)).toBe("");
      expect(optionalString({ wakeName: "hello" }, "wakeName", 10)).toBe("hello");
      expect(optionalString({ wakeName: "1234567890" }, "wakeName", 10)).toBe("1234567890");
    });

    it("throws HttpError 400 invalid_request when string exceeds maximumLength", () => {
      expect(() => optionalString({ address: "12345678901" }, "address", 10)).toThrowError();
      try {
        optionalString({ address: "12345678901" }, "address", 10);
      } catch (error) {
        expect(error).toMatchObject({
          status: 400,
          code: "invalid_request",
          message: "Field 'address' must be a string of at most 10 characters.",
        } satisfies Partial<HttpError>);
      }
    });

    it("throws HttpError 400 invalid_request when field is present but non-string", () => {
      const invalidCases: Array<[string, Record<string, unknown>]> = [
        ["null value", { field: null }],
        ["numeric value", { field: 123 }],
        ["boolean true", { field: true }],
        ["boolean false", { field: false }],
        ["object value", { field: {} }],
        ["array value", { field: ["str"] }],
      ];

      for (const [description, body] of invalidCases) {
        expect(
          () => optionalString(body, "field", 10),
          `failed for case: ${description}`,
        ).toThrowError();
        try {
          optionalString(body, "field", 10);
        } catch (error) {
          expect(error).toMatchObject({
            status: 400,
            code: "invalid_request",
            message: "Field 'field' must be a string of at most 10 characters.",
          } satisfies Partial<HttpError>);
        }
      }
    });
  });

  describe("requiredBoolean", () => {
    it("returns boolean value when field is a valid boolean", () => {
      expect(requiredBoolean({ enabled: true }, "enabled")).toBe(true);
      expect(requiredBoolean({ enabled: false }, "enabled")).toBe(false);
    });

    it("throws HttpError 400 invalid_request when field is missing, null, or non-boolean", () => {
      const invalidCases: Array<[string, Record<string, unknown>]> = [
        ["missing field", {}],
        ["null value", { flag: null }],
        ["undefined value", { flag: undefined }],
        ["string value", { flag: "true" }],
        ["numeric value 1", { flag: 1 }],
        ["numeric value 0", { flag: 0 }],
        ["object value", { flag: {} }],
        ["array value", { flag: [true] }],
      ];

      for (const [description, body] of invalidCases) {
        expect(
          () => requiredBoolean(body, "flag"),
          `failed for case: ${description}`,
        ).toThrowError();
        try {
          requiredBoolean(body, "flag");
        } catch (error) {
          expect(error).toMatchObject({
            status: 400,
            code: "invalid_request",
            message: "Field 'flag' must be a boolean.",
          } satisfies Partial<HttpError>);
        }
      }
    });
  });

  describe("requiredInteger", () => {
    it("returns integer value when field is a valid integer within bounds", () => {
      expect(requiredInteger({ count: 0 }, "count", 0, 10)).toBe(0);
      expect(requiredInteger({ count: 5 }, "count", 0, 10)).toBe(5);
      expect(requiredInteger({ count: 10 }, "count", 0, 10)).toBe(10);
      expect(requiredInteger({ val: -5 }, "val", -10, 10)).toBe(-5);
    });

    it("throws HttpError 400 invalid_request when field is missing, non-integer, or out of bounds", () => {
      const invalidCases: Array<[string, Record<string, unknown>]> = [
        ["missing field", {}],
        ["null value", { count: null }],
        ["undefined value", { count: undefined }],
        ["string value", { count: "5" }],
        ["boolean true", { count: true }],
        ["boolean false", { count: false }],
        ["object value", { count: {} }],
        ["array value", { count: [5] }],
        ["floating point", { count: 5.5 }],
        ["NaN value", { count: Number.NaN }],
        ["Infinity value", { count: Number.POSITIVE_INFINITY }],
        ["below minimum", { count: -1 }],
        ["above maximum", { count: 11 }],
      ];

      for (const [description, body] of invalidCases) {
        expect(
          () => requiredInteger(body, "count", 0, 10),
          `failed for case: ${description}`,
        ).toThrowError();
        try {
          requiredInteger(body, "count", 0, 10);
        } catch (error) {
          expect(error).toMatchObject({
            status: 400,
            code: "invalid_request",
            message: "Field 'count' must be an integer between 0 and 10.",
          } satisfies Partial<HttpError>);
        }
      }
    });
  });

  it("accepts JSON objects and trims required strings", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "  Ada  " }),
    });
    const body = await readJsonObject(request);
    expect(requiredString(body, "displayName", 80)).toBe("Ada");
  });

  it("returns a typed error for a missing content type", async () => {
    const request = new Request("https://example.test", { method: "POST", body: "{}" });
    await expect(readJsonObject(request)).rejects.toMatchObject({
      status: 415,
      code: "unsupported_media_type",
    } satisfies Partial<HttpError>);
  });

  it("throws 413 payload_too_large when Content-Length header exceeds limit", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "32769",
      },
      body: JSON.stringify({ displayName: "Ada" }),
    });
    await expect(readJsonObject(request)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
      message: "Request body exceeds maximum allowed size.",
    } satisfies Partial<HttpError>);
  });

  it("throws 413 payload_too_large when request body exceeds 32 KiB limit", async () => {
    const largeData = "a".repeat(32769);
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: largeData }),
    });
    await expect(readJsonObject(request)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
      message: "Request body exceeds maximum allowed size.",
    } satisfies Partial<HttpError>);
  });
});
