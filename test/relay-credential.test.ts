import { describe, expect, it } from "vitest";
import { configuredRelayCredential, inspectRelayCredential } from "../src/worker/relayCredential";

function encodeRawPayload(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function makeJwt(payloadObj: unknown, header = "header", signature = "signature"): string {
  return `${header}.${encodeRawPayload(JSON.stringify(payloadObj))}.${signature}`;
}

describe("inspectRelayCredential & configuredRelayCredential", () => {
  describe("missing credential handling", () => {
    it("returns status missing when secret is undefined, empty, or whitespace-only", () => {
      expect(inspectRelayCredential(undefined)).toEqual({
        status: "missing",
        credential: null,
      });
      expect(inspectRelayCredential("")).toEqual({
        status: "missing",
        credential: null,
      });
      expect(inspectRelayCredential("   \t\n  ")).toEqual({
        status: "missing",
        credential: null,
      });
      expect(configuredRelayCredential(undefined)).toBeNull();
      expect(configuredRelayCredential("   ")).toBeNull();
    });
  });

  describe("malformed JWT structure and regex validation", () => {
    it("returns status invalid when token does not have exactly three dot-separated segments", () => {
      expect(inspectRelayCredential("single-segment")).toEqual({
        status: "invalid",
        credential: null,
      });
      expect(inspectRelayCredential("two.segments")).toEqual({
        status: "invalid",
        credential: null,
      });
      expect(inspectRelayCredential("four.segments.here.now")).toEqual({
        status: "invalid",
        credential: null,
      });
    });

    it("returns status invalid when segments contain invalid JWT characters", () => {
      expect(inspectRelayCredential("head er.payload.signature")).toEqual({
        status: "invalid",
        credential: null,
      });
      expect(inspectRelayCredential("header.pay!load.signature")).toEqual({
        status: "invalid",
        credential: null,
      });
      expect(inspectRelayCredential("header.payload.sig@nature")).toEqual({
        status: "invalid",
        credential: null,
      });
    });
  });

  describe("try-catch error handling for base64 decoding and JSON parsing", () => {
    it("catches base64 decoding errors (e.g. invalid base64 padding or length) and returns status invalid", () => {
      // "a" has length 1 (% 4 = 1) which causes atob to throw during decodeBase64Url
      const tokenWithBadBase64 = "header.a.signature";
      expect(inspectRelayCredential(tokenWithBadBase64)).toEqual({
        status: "invalid",
        credential: null,
      });
    });

    it("catches JSON syntax errors when payload is valid base64url but invalid JSON", () => {
      const badJsonPayload = encodeRawPayload("{ invalid json syntax }");
      const tokenWithBadJson = `header.${badJsonPayload}.signature`;
      expect(inspectRelayCredential(tokenWithBadJson)).toEqual({
        status: "invalid",
        credential: null,
      });
    });
  });

  describe("claims payload shape validation", () => {
    it("returns status invalid when claims payload is null or primitive", () => {
      const nullClaimsToken = `header.${encodeRawPayload("null")}.signature`;
      expect(inspectRelayCredential(nullClaimsToken)).toEqual({
        status: "invalid",
        credential: null,
      });

      const numberClaimsToken = `header.${encodeRawPayload("12345")}.signature`;
      expect(inspectRelayCredential(numberClaimsToken)).toEqual({
        status: "invalid",
        credential: null,
      });

      const stringClaimsToken = `header.${encodeRawPayload('"just a string"')}.signature`;
      expect(inspectRelayCredential(stringClaimsToken)).toEqual({
        status: "invalid",
        credential: null,
      });

      const booleanClaimsToken = `header.${encodeRawPayload("true")}.signature`;
      expect(inspectRelayCredential(booleanClaimsToken)).toEqual({
        status: "invalid",
        credential: null,
      });
    });

    it("returns status invalid when claims payload is an array", () => {
      const arrayClaimsToken = `header.${encodeRawPayload('[{"exp": 200000}]')}.signature`;
      expect(inspectRelayCredential(arrayClaimsToken)).toEqual({
        status: "invalid",
        credential: null,
      });
    });
  });

  describe("exp claim validation", () => {
    it("returns status invalid when exp claim is missing", () => {
      const token = makeJwt({ sub: "user-123" });
      expect(inspectRelayCredential(token)).toEqual({
        status: "invalid",
        credential: null,
      });
    });

    it("returns status invalid when exp claim is not a number", () => {
      expect(inspectRelayCredential(makeJwt({ exp: "200000" }))).toEqual({
        status: "invalid",
        credential: null,
      });
      expect(inspectRelayCredential(makeJwt({ exp: true }))).toEqual({
        status: "invalid",
        credential: null,
      });
      expect(inspectRelayCredential(makeJwt({ exp: null }))).toEqual({
        status: "invalid",
        credential: null,
      });
      expect(inspectRelayCredential(makeJwt({ exp: { seconds: 200000 } }))).toEqual({
        status: "invalid",
        credential: null,
      });
      expect(inspectRelayCredential(makeJwt({ exp: [200000] }))).toEqual({
        status: "invalid",
        credential: null,
      });
    });

    it("returns status invalid when exp claim is zero or negative", () => {
      expect(inspectRelayCredential(makeJwt({ exp: 0 }))).toEqual({
        status: "invalid",
        credential: null,
      });
      expect(inspectRelayCredential(makeJwt({ exp: -100 }))).toEqual({
        status: "invalid",
        credential: null,
      });
    });
  });

  describe("expiration timing and boundary conditions", () => {
    it("returns status expired when nowMs / 1000 is greater than or equal to expiresAtSeconds", () => {
      const token = makeJwt({ exp: 100 });
      // Exact boundary: nowMs = 100,000 ms -> 100 seconds >= 100 exp -> expired
      expect(inspectRelayCredential(token, 100_000)).toEqual({
        status: "expired",
        credential: null,
      });
      // Past boundary: nowMs = 100,001 ms -> 100.001 seconds >= 100 exp -> expired
      expect(inspectRelayCredential(token, 100_001)).toEqual({
        status: "expired",
        credential: null,
      });
      expect(configuredRelayCredential(token, 100_000)).toBeNull();
    });

    it("returns status available when nowMs / 1000 is strictly less than expiresAtSeconds", () => {
      const token = makeJwt({ exp: 100 });
      // Just before boundary: nowMs = 99,999 ms -> 99.999 seconds < 100 exp -> available
      expect(inspectRelayCredential(token, 99_999)).toEqual({
        status: "available",
        credential: token,
      });
      expect(configuredRelayCredential(token, 99_999)).toBe(token);
    });

    it("trims leading/trailing whitespace when returning credential in available status", () => {
      const rawToken = makeJwt({ exp: 100 });
      const paddedToken = `   ${rawToken}  \n`;
      expect(inspectRelayCredential(paddedToken, 99_999)).toEqual({
        status: "available",
        credential: rawToken,
      });
      expect(configuredRelayCredential(paddedToken, 99_999)).toBe(rawToken);
    });
  });
});
