import { describe, expect, it } from "vitest";
import { configFlag, configValue } from "../src/worker/env";

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
});
