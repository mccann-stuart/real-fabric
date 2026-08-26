import { describe, expect, it } from "vitest";
import {
  type HttpError,
  readJsonObject,
  requiredBoolean,
  requiredEnum,
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

    it("throws HttpError 400 invalid_request when field is missing, null, non-string, or not in allowed list", () => {
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
});
