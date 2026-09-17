import { describe, expect, it } from "vitest";
import {
  type BrowserCapabilityEvidence,
  CONFIGURATION_TARGETS,
  currentUserAgentFacts,
  describePin,
  describeTargets,
  IOS_CHROME_CONFIGURATION,
  IOS_SAFARI_CONFIGURATION,
  MACOS_SAFARI_CONFIGURATION,
  matchConfiguration,
  PINNED_CONFIGURATION,
  type PinnedConfiguration,
  type UserAgentFacts,
} from "../src/shared/pinnedConfiguration";

const READY_CAPABILITIES: BrowserCapabilityEvidence = {
  state: "ready",
  missing: [],
};

describe("pinnedConfiguration", () => {
  describe("describePin & describeTargets", () => {
    it("describes PINNED_CONFIGURATION by default when no argument is passed", () => {
      expect(describePin()).toBe("Google Chrome 141+ on macOS");
    });

    it("describes desktop pin without platform minimum version", () => {
      expect(describePin(PINNED_CONFIGURATION)).toBe("Google Chrome 141+ on macOS");
    });

    it("describes iPhone pin with platform minimum version", () => {
      expect(describePin(IOS_SAFARI_CONFIGURATION)).toBe("Safari 27+ on iPhone iOS 27+");
    });

    it("describes custom pin configurations", () => {
      const customPin: PinnedConfiguration = {
        browser: "Safari",
        minimumMajorVersion: 26,
        platform: "iOS",
        device: "iPhone",
        status: "provisional",
        note: "Test note",
      };
      expect(describePin(customPin)).toBe("Safari 26+ on iPhone iOS");

      const customDesktopPin: PinnedConfiguration = {
        browser: "Google Chrome",
        minimumMajorVersion: 130,
        platform: "macOS",
        minimumPlatformMajorVersion: 14,
        device: "desktop",
        status: "signed_off",
        note: "Signed off note",
      };
      expect(describePin(customDesktopPin)).toBe("Google Chrome 130+ on macOS 14+");
    });

    it("describeTargets formats all target configurations into a semicolon-separated string", () => {
      const expected = CONFIGURATION_TARGETS.map((target) => describePin(target)).join("; ");
      expect(describeTargets()).toBe(expected);
      expect(describeTargets()).toBe(
        "Google Chrome 141+ on macOS; Safari 27+ on macOS; Safari 27+ on iPhone iOS 27+; Google Chrome 141+ on iPhone iOS 27+",
      );
    });
  });

  describe("matchConfiguration - Chrome on macOS", () => {
    const MACOS_CHROME_141 =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

    it("matches provisional Chrome 141 on macOS", () => {
      const match = matchConfiguration({
        userAgent: MACOS_CHROME_141,
        brands: [{ brand: "Google Chrome", version: "141" }],
        platform: "macOS",
      });
      expect(match).toMatchObject({
        status: "provisional",
        liveAudioEligible: true,
        browser: "Google Chrome 141",
        browserMajorVersion: 141,
        platform: "macOS",
        device: "desktop",
        target: PINNED_CONFIGURATION,
      });
    });

    it("returns supported status if PINNED_CONFIGURATION is signed_off", () => {
      // Modify pin status temporarily or simulate match logic
      const originalStatus = PINNED_CONFIGURATION.status;
      try {
        (PINNED_CONFIGURATION as { status: string }).status = "signed_off";
        const match = matchConfiguration({
          userAgent: MACOS_CHROME_141,
          brands: [{ brand: "Google Chrome", version: "141" }],
          platform: "macOS",
        });
        expect(match.status).toBe("supported");
        expect(match.liveAudioEligible).toBe(true);
      } finally {
        (PINNED_CONFIGURATION as { status: string }).status = originalStatus;
      }
    });

    it("rejects Chrome below minimum major version floor on macOS", () => {
      const match = matchConfiguration({
        userAgent: MACOS_CHROME_141.replace("Chrome/141", "Chrome/140"),
        brands: [{ brand: "Google Chrome", version: "140" }],
        platform: "macOS",
      });
      expect(match.status).toBe("unsupported");
      expect(match.liveAudioEligible).toBe(false);
      expect(match.reasons[0]).toContain("The Chrome floor is 141");
    });
  });

  describe("matchConfiguration - macOS Safari", () => {
    const MACOS_SAFARI_27 =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";

    it("matches provisional macOS Safari 27", () => {
      const match = matchConfiguration({
        userAgent: MACOS_SAFARI_27,
        maxTouchPoints: 0,
      });
      expect(match).toMatchObject({
        status: "provisional",
        liveAudioEligible: true,
        browser: "Safari 27",
        browserMajorVersion: 27,
        platform: "macOS",
        device: "desktop",
        target: MACOS_SAFARI_CONFIGURATION,
      });
    });

    it("returns supported status if MACOS_SAFARI_CONFIGURATION is signed_off", () => {
      const originalStatus = MACOS_SAFARI_CONFIGURATION.status;
      try {
        (MACOS_SAFARI_CONFIGURATION as { status: string }).status = "signed_off";
        const match = matchConfiguration({
          userAgent: MACOS_SAFARI_27,
          maxTouchPoints: 0,
        });
        expect(match.status).toBe("supported");
        expect(match.liveAudioEligible).toBe(true);
      } finally {
        (MACOS_SAFARI_CONFIGURATION as { status: string }).status = originalStatus;
      }
    });

    it("flags iPadOS in desktop mode (Macintosh user agent with touch points)", () => {
      const match = matchConfiguration({
        userAgent: MACOS_SAFARI_27,
        maxTouchPoints: 5,
      });
      expect(match.status).toBe("readOnly");
      expect(match.device).toBe("iPad");
      expect(match.liveAudioEligible).toBe(false);
      expect(match.reasons[0]).toContain("iPadOS Safari in desktop mode");
    });

    it("rejects Safari below major version floor", () => {
      const match = matchConfiguration({
        userAgent: MACOS_SAFARI_27.replace("Version/27.0", "Version/26.0"),
        maxTouchPoints: 0,
      });
      expect(match.status).toBe("unsupported");
      expect(match.liveAudioEligible).toBe(false);
      expect(match.reasons[0]).toContain("macOS Safari floor is 27");
    });
  });

  describe("matchConfiguration - iPhone Safari", () => {
    const IPHONE_SAFARI_27 =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";
    const FROZEN_IPHONE_SAFARI_27 = IPHONE_SAFARI_27.replace(
      "CPU iPhone OS 27_0",
      "CPU iPhone OS 18_7",
    );

    it("matches top-level Safari 27 on iPhone with OS 27", () => {
      const match = matchConfiguration({ userAgent: IPHONE_SAFARI_27 });
      expect(match.status).toBe("provisional");
      expect(match.liveAudioEligible).toBe(true);
      expect(match.target).toBe(IOS_SAFARI_CONFIGURATION);
    });

    it("handles higher major version than initially tested (e.g. Safari 28)", () => {
      const match = matchConfiguration(
        { userAgent: IPHONE_SAFARI_27.replace("Version/27.0", "Version/28.0") },
        READY_CAPABILITIES,
      );
      expect(match.status).toBe("provisional");
      expect(match.reasons[0]).toContain(
        "has not been added to the physical-device acceptance matrix",
      );
    });

    it("handles checking state capability evidence", () => {
      const match = matchConfiguration(
        { userAgent: IPHONE_SAFARI_27 },
        { state: "checking", missing: [] },
      );
      expect(match.status).toBe("checking");
      expect(match.liveAudioEligible).toBe(false);
    });

    it("handles unavailable capability evidence with fallback missing message", () => {
      const match = matchConfiguration(
        { userAgent: IPHONE_SAFARI_27 },
        { state: "unavailable", missing: [] },
      );
      expect(match.status).toBe("readOnly");
      expect(match.reasons[0]).toContain("an unidentified capability");
    });

    it("handles unavailable capability evidence listing missing capabilities", () => {
      const match = matchConfiguration(
        { userAgent: IPHONE_SAFARI_27 },
        { state: "unavailable", missing: ["Opus", "WebTransport"] },
      );
      expect(match.status).toBe("readOnly");
      expect(match.reasons[0]).toContain("Opus, WebTransport");
    });

    it("returns readOnly if standalone (Home Screen mode)", () => {
      const match = matchConfiguration({ userAgent: IPHONE_SAFARI_27, standalone: true });
      expect(match.status).toBe("readOnly");
      expect(match.reasons[0]).toContain("Installed Home Screen mode");
    });

    it("returns readOnly for unknown/other iOS browsers on iPhone", () => {
      const match = matchConfiguration({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      });
      expect(match.status).toBe("readOnly");
      expect(match.reasons[0]).toContain("This is not top-level Safari or Chrome for iOS");
    });

    it("returns readOnly if Safari version is below floor", () => {
      const match = matchConfiguration({
        userAgent: IPHONE_SAFARI_27.replace("Version/27.0", "Version/26.0"),
      });
      expect(match.status).toBe("readOnly");
      expect(match.reasons[0]).toContain("working-audio browser floor is Safari 27");
    });

    it("handles missing capability evidence when OS token is frozen/below minimum", () => {
      const match = matchConfiguration({ userAgent: FROZEN_IPHONE_SAFARI_27 });
      expect(match.status).toBe("readOnly");
      expect(match.reasons[0]).toContain("Required browser capability evidence was not supplied");
    });
  });

  describe("matchConfiguration - iPhone Chrome", () => {
    const IPHONE_CHROME_141 =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1";

    it("matches Chrome 141 on iPhone", () => {
      const match = matchConfiguration({ userAgent: IPHONE_CHROME_141 });
      expect(match.status).toBe("provisional");
      expect(match.liveAudioEligible).toBe(true);
      expect(match.target).toBe(IOS_CHROME_CONFIGURATION);
    });

    it("returns readOnly if Chrome version is below floor on iPhone", () => {
      const match = matchConfiguration({
        userAgent: IPHONE_CHROME_141.replace("CriOS/141", "CriOS/140"),
      });
      expect(match.status).toBe("readOnly");
      expect(match.reasons[0]).toContain("working-audio browser floor is Chrome 141");
    });

    it("handles checking capability evidence on iPhone Chrome", () => {
      const match = matchConfiguration(
        { userAgent: IPHONE_CHROME_141 },
        { state: "checking", missing: [] },
      );
      expect(match.status).toBe("checking");
    });

    it("handles missing capability evidence on frozen OS token", () => {
      const frozenChrome = IPHONE_CHROME_141.replace("CPU iPhone OS 27_0", "CPU iPhone OS 18_7");
      const match = matchConfiguration({ userAgent: frozenChrome });
      expect(match.status).toBe("readOnly");
      expect(match.reasons[0]).toContain("Required browser capability evidence was not supplied");
    });
  });

  describe("matchConfiguration - Non-iPhone iOS, other platforms and unknown browsers", () => {
    it("returns readOnly for non-iPhone iOS devices (e.g. iPad / iPod)", () => {
      const match = matchConfiguration({
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      });
      expect(match.status).toBe("readOnly");
      expect(match.platform).toBe("iOS");
      expect(match.device).toBe("iPad");
    });

    it("handles Chrome on non-macOS platforms (e.g. Windows)", () => {
      const match = matchConfiguration({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        brands: [{ brand: "Google Chrome", version: "141" }],
        platform: "Windows",
      });
      expect(match.status).toBe("unsupported");
      expect(match.reasons[0]).toContain(
        "The Chrome audio target runs on macOS; this session reports Windows.",
      );
      expect(match.target).toBe(PINNED_CONFIGURATION);
    });

    it("describes unknown browsers using brand data", () => {
      const match = matchConfiguration({
        userAgent: "Mozilla/5.0 (Windows NT 10.0)",
        brands: [
          { brand: "Not A Brand", version: "99" },
          { brand: "CustomBrowser", version: "12" },
        ],
      });
      expect(match.browser).toBe("CustomBrowser 12");
      expect(match.status).toBe("unsupported");
      expect(match.target).toBeNull();
    });

    it("describes unknown iOS browsers (FxiOS / EdgiOS / OPiOS)", () => {
      const match = matchConfiguration({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) FxiOS/120.0 Mobile/15E148",
      });
      expect(match.browser).toBe("FxiOS 120");
    });

    it("describes unknown Safari browsers", () => {
      const match = matchConfiguration({
        userAgent: "Mozilla/5.0 (Linux; Android 14) Version/15.0 Safari/604.1",
      });
      expect(match.browser).toBe("Safari 15");
    });

    it("describes legacy browsers (Firefox, Edg, OPR, Brave, SamsungBrowser)", () => {
      const match = matchConfiguration({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
      });
      expect(match.browser).toBe("Firefox 120");
    });

    it("describes completely unidentified browsers", () => {
      const match = matchConfiguration({
        userAgent: "UnknownBot/1.0",
      });
      expect(match.browser).toBe("an unidentified browser");
    });

    it("detects platforms accurately across declared and userAgent patterns", () => {
      expect(matchConfiguration({ userAgent: "Mozilla/5.0", platform: "iPhone" }).platform).toBe(
        "iOS",
      );
      expect(matchConfiguration({ userAgent: "Mozilla/5.0", platform: "Win32" }).platform).toBe(
        "Windows",
      );
      expect(matchConfiguration({ userAgent: "Mozilla/5.0", platform: "MacIntel" }).platform).toBe(
        "macOS",
      );
      expect(matchConfiguration({ userAgent: "Mozilla/5.0", platform: "CustomOS" }).platform).toBe(
        "CustomOS",
      );
      expect(matchConfiguration({ userAgent: "Mozilla/5.0 (Android 14)" }).platform).toBe(
        "Android",
      );
      expect(matchConfiguration({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }).platform).toBe(
        "Linux",
      );
      expect(
        matchConfiguration({ userAgent: "Mozilla/5.0 (iPod; CPU iPhone OS 16_0 like Mac OS X)" })
          .platform,
      ).toBe("iOS");
      expect(matchConfiguration({ userAgent: "Some Unknown Agent" }).platform).toBe(
        "an unrecognised platform",
      );
    });

    it("detects devices accurately across userAgent patterns", () => {
      expect(matchConfiguration({ userAgent: "Mozilla/5.0 (iPhone; CPU OS 17_0)" }).device).toBe(
        "iPhone",
      );
      expect(matchConfiguration({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0)" }).device).toBe(
        "iPad",
      );
      expect(
        matchConfiguration({ userAgent: "Mozilla/5.0 (Linux; Android 14; Mobile)" }).device,
      ).toBe("mobile");
      expect(matchConfiguration({ userAgent: "Mozilla/5.0 (Windows NT 10.0)" }).device).toBe(
        "desktop",
      );
    });
  });

  describe("currentUserAgentFacts", () => {
    const originalNavigator = globalThis.navigator;

    it("returns facts from navigator including userAgentData, standalone, and maxTouchPoints", () => {
      try {
        Object.defineProperty(globalThis, "navigator", {
          value: {
            userAgent: "TestAgent/1.0",
            userAgentData: {
              brands: [{ brand: "Google Chrome", version: "141" }],
              platform: "macOS",
            },
            standalone: true,
            maxTouchPoints: 5,
          },
          configurable: true,
          writable: true,
        });

        const facts: UserAgentFacts = currentUserAgentFacts();
        expect(facts).toEqual({
          userAgent: "TestAgent/1.0",
          brands: [{ brand: "Google Chrome", version: "141" }],
          platform: "macOS",
          standalone: true,
          maxTouchPoints: 5,
        });
      } finally {
        Object.defineProperty(globalThis, "navigator", {
          value: originalNavigator,
          configurable: true,
          writable: true,
        });
      }
    });

    it("returns minimal facts when navigator fields are missing", () => {
      try {
        Object.defineProperty(globalThis, "navigator", {
          value: {
            userAgent: "MinimalAgent/1.0",
          },
          configurable: true,
          writable: true,
        });

        const facts = currentUserAgentFacts();
        expect(facts).toEqual({
          userAgent: "MinimalAgent/1.0",
        });
      } finally {
        Object.defineProperty(globalThis, "navigator", {
          value: originalNavigator,
          configurable: true,
          writable: true,
        });
      }
    });
  });
});
