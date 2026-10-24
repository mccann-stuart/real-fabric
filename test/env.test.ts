import { describe, expect, it } from "vitest";
import { configFlag, configValue } from "../src/worker/env";
import { inspectRelayCredential } from "../src/worker/relayCredential";

describe("env configuration helpers", () => {
  describe("configValue", () => {
    it("returns string values unchanged", () => {
      expect(configValue("https://example.com")).toBe("https://example.com");
      expect(configValue("draft-16")).toBe("draft-16");
      expect(configValue("")).toBe("");
    });
  });

  describe("configFlag", () => {
    it("returns true when string value equals 'true'", () => {
      expect(configFlag("true")).toBe(true);
    });

    it("returns false for non-'true' values", () => {
      expect(configFlag("false")).toBe(false);
      expect(configFlag("TRUE")).toBe(false);
      expect(configFlag("true ")).toBe(false);
      expect(configFlag(" true")).toBe(false);
      expect(configFlag("1")).toBe(false);
      expect(configFlag("yes")).toBe(false);
      expect(configFlag("")).toBe(false);
    });
  });

  describe("inspectRelayCredential", () => {
    it("returns status 'missing' for empty or undefined tokens", () => {
      expect(inspectRelayCredential(undefined)).toEqual({ status: "missing", credential: null });
      expect(inspectRelayCredential("   ")).toEqual({ status: "missing", credential: null });
    });

    it("returns status 'invalid' for tokens exceeding maximum length (4096 chars)", () => {
      const hugeToken = "a".repeat(4097);
      expect(inspectRelayCredential(hugeToken)).toEqual({ status: "invalid", credential: null });
    });

    it("returns status 'invalid' for malformed tokens", () => {
      expect(inspectRelayCredential("not.a.valid.jwt")).toEqual({
        status: "invalid",
        credential: null,
      });
      expect(inspectRelayCredential("invalid-token-format")).toEqual({
        status: "invalid",
        credential: null,
      });
    });
  });
});
