import { describe, expect, it } from "vitest";
import { configFlag, configValue } from "../src/worker/env";

describe("env configuration helpers", () => {
  describe("configValue", () => {
    it("returns string values unchanged when clean", () => {
      expect(configValue("https://example.com")).toBe("https://example.com");
      expect(configValue("enforced")).toBe("enforced");
      expect(configValue("cooperative")).toBe("cooperative");
    });

    it("trims leading and trailing whitespace", () => {
      expect(configValue("  https://example.com  ")).toBe("https://example.com");
      expect(configValue("\n\tenforced\t")).toBe("enforced");
      expect(configValue("   ")).toBe("");
    });

    it("handles empty strings", () => {
      expect(configValue("")).toBe("");
    });

    it("widens narrow literal types to string", () => {
      const literalValue: "literal-value" = "literal-value";
      const result: string = configValue(literalValue);
      expect(result).toBe("literal-value");
    });
  });

  describe("configFlag", () => {
    it("returns true when string value is 'true' (ignoring whitespace)", () => {
      expect(configFlag("true")).toBe(true);
      expect(configFlag("  true  ")).toBe(true);
      expect(configFlag("\ntrue\t")).toBe(true);
    });

    it("returns false for non-'true' string values", () => {
      expect(configFlag("false")).toBe(false);
      expect(configFlag("TRUE")).toBe(false);
      expect(configFlag("True")).toBe(false);
      expect(configFlag("1")).toBe(false);
      expect(configFlag("yes")).toBe(false);
      expect(configFlag("")).toBe(false);
    });
  });
});
