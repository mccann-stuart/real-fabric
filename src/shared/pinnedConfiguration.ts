/**
 * H3: live audio is admitted only for a named browser, operating system and
 * major-version floor. Capability checks still run afterwards; identifying as
 * a target never turns an unverified transport into a support claim.
 */

export type PinStatus = "provisional" | "signed_off";
export type ConfigurationStatus = "supported" | "provisional" | "readOnly" | "unsupported";

export interface PinnedConfiguration {
  browser: "Google Chrome" | "Safari";
  minimumMajorVersion: number;
  platform: "macOS" | "iOS";
  minimumPlatformMajorVersion?: number;
  device: "desktop" | "iPhone";
  status: PinStatus;
  /** Rendered wherever the pin is quoted, so provisional never reads as verified. */
  note: string;
}

export const PINNED_CONFIGURATION: PinnedConfiguration = {
  browser: "Google Chrome",
  minimumMajorVersion: 141,
  platform: "macOS",
  device: "desktop",
  status: "provisional",
  note: "Provisional pin. Gate 2 browser-to-relay and acoustic acceptance remain open.",
};

export const IOS_SAFARI_CONFIGURATION: PinnedConfiguration = {
  browser: "Safari",
  minimumMajorVersion: 27,
  platform: "iOS",
  minimumPlatformMajorVersion: 27,
  device: "iPhone",
  status: "provisional",
  note: "Candidate configuration. A physical iPhone running iOS 27 and Safari 27 has not yet passed Gate 1 or Gate 2 acceptance.",
};

export const CONFIGURATION_TARGETS = [PINNED_CONFIGURATION, IOS_SAFARI_CONFIGURATION] as const;

export function describePin(pin: PinnedConfiguration = PINNED_CONFIGURATION): string {
  const platformFloor = pin.minimumPlatformMajorVersion
    ? ` ${pin.minimumPlatformMajorVersion}+`
    : "";
  return `${pin.browser} ${pin.minimumMajorVersion}+ on ${pin.device === "iPhone" ? "iPhone " : ""}${pin.platform}${platformFloor}`;
}

export function describeTargets(): string {
  return CONFIGURATION_TARGETS.map((target) => describePin(target)).join("; ");
}

export interface ConfigurationMatch {
  status: ConfigurationStatus;
  liveAudioEligible: boolean;
  reasons: string[];
  browser: string;
  browserMajorVersion: number | null;
  platform: string;
  osMajorVersion: number | null;
  device: string;
  target: PinnedConfiguration | null;
}

export interface UserAgentFacts {
  userAgent: string;
  /** `navigator.userAgentData.brands`, when the browser exposes it. */
  brands?: Array<{ brand: string; version: string }>;
  platform?: string;
  /** Safari's non-standard standalone flag. Home Screen mode is not in this branch. */
  standalone?: boolean;
}

/**
 * Deliberately strict user-agent classification. iPhone Safari is checked
 * before the Macintosh token because Apple user-agent strings may contain Mac
 * compatibility tokens. Unknown or embedded iOS browsers remain read-only.
 */
export function matchConfiguration(facts: UserAgentFacts): ConfigurationMatch {
  const platform = detectPlatform(facts);
  const device = detectDevice(facts);

  if (device === "iPhone") return matchIphoneSafari(facts, platform);

  const chrome = detectChrome(facts);
  if (chrome && platform === PINNED_CONFIGURATION.platform) {
    if (chrome.majorVersion < PINNED_CONFIGURATION.minimumMajorVersion) {
      return result({
        status: "unsupported",
        browser: `${chrome.brand} ${chrome.majorVersion}`,
        browserMajorVersion: chrome.majorVersion,
        platform,
        device,
        target: PINNED_CONFIGURATION,
        reasons: [
          `The Chrome floor is ${PINNED_CONFIGURATION.minimumMajorVersion}; this session reports ${chrome.majorVersion}.`,
        ],
      });
    }
    return result({
      status: PINNED_CONFIGURATION.status === "signed_off" ? "supported" : "provisional",
      browser: `${chrome.brand} ${chrome.majorVersion}`,
      browserMajorVersion: chrome.majorVersion,
      platform,
      device,
      target: PINNED_CONFIGURATION,
      reasons: [PINNED_CONFIGURATION.note],
    });
  }

  if (platform === "iOS") {
    return result({
      status: "readOnly",
      browser: describeUnknownBrowser(facts),
      browserMajorVersion: detectSafari(facts)?.majorVersion ?? null,
      platform,
      device,
      target: null,
      reasons: ["Only top-level Safari on iPhone is admitted to the iOS 27 audio candidate."],
    });
  }

  return result({
    status: "unsupported",
    browser: chrome ? `${chrome.brand} ${chrome.majorVersion}` : describeUnknownBrowser(facts),
    browserMajorVersion: chrome?.majorVersion ?? null,
    platform,
    device,
    target: chrome ? PINNED_CONFIGURATION : null,
    reasons: [
      chrome
        ? `The Chrome audio target runs on ${PINNED_CONFIGURATION.platform}; this session reports ${platform}.`
        : `This browser does not identify as ${PINNED_CONFIGURATION.browser} or top-level iPhone Safari.`,
    ],
  });
}

function matchIphoneSafari(facts: UserAgentFacts, platform: string): ConfigurationMatch {
  const safari = detectSafari(facts);
  const osMajorVersion = detectIphoneOsMajor(facts.userAgent);

  if (facts.standalone) {
    return result({
      status: "readOnly",
      browser: safari ? `Safari ${safari.majorVersion}` : describeUnknownBrowser(facts),
      browserMajorVersion: safari?.majorVersion ?? null,
      platform,
      osMajorVersion,
      device: "iPhone",
      target: IOS_SAFARI_CONFIGURATION,
      reasons: ["Installed Home Screen mode has a different lifecycle and is outside this branch."],
    });
  }

  if (!safari) {
    return result({
      status: "readOnly",
      browser: describeUnknownBrowser(facts),
      browserMajorVersion: null,
      platform,
      osMajorVersion,
      device: "iPhone",
      target: IOS_SAFARI_CONFIGURATION,
      reasons: [
        "This is not top-level Safari. Alternative iOS browsers and embedded web views remain read-only.",
      ],
    });
  }

  const minimumOs = IOS_SAFARI_CONFIGURATION.minimumPlatformMajorVersion ?? 27;
  const belowFloor =
    osMajorVersion === null ||
    osMajorVersion < minimumOs ||
    safari.majorVersion < IOS_SAFARI_CONFIGURATION.minimumMajorVersion;
  if (belowFloor) {
    return result({
      status: "readOnly",
      browser: `Safari ${safari.majorVersion}`,
      browserMajorVersion: safari.majorVersion,
      platform,
      osMajorVersion,
      device: "iPhone",
      target: IOS_SAFARI_CONFIGURATION,
      reasons: [
        osMajorVersion === null
          ? "The iOS version could not be identified, so the iOS 27 floor cannot be verified."
          : `The working-audio floor is iOS ${minimumOs} and Safari ${IOS_SAFARI_CONFIGURATION.minimumMajorVersion}; this session reports iOS ${osMajorVersion} and Safari ${safari.majorVersion}.`,
      ],
    });
  }

  const initiallyTestedMajor =
    osMajorVersion === minimumOs &&
    safari.majorVersion === IOS_SAFARI_CONFIGURATION.minimumMajorVersion;
  return result({
    status: "provisional",
    browser: `Safari ${safari.majorVersion}`,
    browserMajorVersion: safari.majorVersion,
    platform,
    osMajorVersion,
    device: "iPhone",
    target: IOS_SAFARI_CONFIGURATION,
    reasons: [
      initiallyTestedMajor
        ? IOS_SAFARI_CONFIGURATION.note
        : `This configuration meets the iOS 27/Safari 27 floor, but iOS ${osMajorVersion}/Safari ${safari.majorVersion} has not been added to the physical-device acceptance matrix.`,
    ],
  });
}

function result(
  input: Omit<ConfigurationMatch, "liveAudioEligible" | "osMajorVersion"> & {
    osMajorVersion?: number | null;
  },
): ConfigurationMatch {
  return {
    ...input,
    osMajorVersion: input.osMajorVersion ?? null,
    liveAudioEligible: input.status === "supported" || input.status === "provisional",
  };
}

function detectChrome(facts: UserAgentFacts): { brand: string; majorVersion: number } | null {
  for (const entry of facts.brands ?? []) {
    if (entry.brand !== "Google Chrome") continue;
    const majorVersion = Number.parseInt(entry.version, 10);
    if (Number.isFinite(majorVersion)) return { brand: entry.brand, majorVersion };
  }
  if (/\b(Edg|OPR|Brave|SamsungBrowser|CriOS|FxiOS|EdgiOS)\//.test(facts.userAgent)) {
    return null;
  }
  const match = facts.userAgent.match(/Chrome\/(\d+)/);
  const majorVersion = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  if (!Number.isFinite(majorVersion)) return null;
  return { brand: "Google Chrome", majorVersion };
}

function detectSafari(facts: UserAgentFacts): { majorVersion: number } | null {
  if (/\b(CriOS|FxiOS|EdgiOS|OPiOS)\//.test(facts.userAgent)) return null;
  if (!/Mobile\//.test(facts.userAgent) || !/Safari\//.test(facts.userAgent)) return null;
  const match = facts.userAgent.match(/Version\/(\d+)/);
  const majorVersion = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(majorVersion) ? { majorVersion } : null;
}

function detectIphoneOsMajor(userAgent: string): number | null {
  const match = userAgent.match(/CPU iPhone OS (\d+)(?:[_.]\d+)*/);
  const majorVersion = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(majorVersion) ? majorVersion : null;
}

function detectPlatform(facts: UserAgentFacts): string {
  if (/iPhone|iPad|iPod/.test(facts.userAgent)) return "iOS";
  const declared = facts.platform ?? "";
  if (declared) return normalisePlatform(declared);
  if (/Mac OS X|Macintosh/.test(facts.userAgent)) return "macOS";
  if (/Windows/.test(facts.userAgent)) return "Windows";
  if (/Android/.test(facts.userAgent)) return "Android";
  if (/Linux/.test(facts.userAgent)) return "Linux";
  return "an unrecognised platform";
}

function detectDevice(facts: UserAgentFacts): string {
  if (/iPhone/.test(facts.userAgent)) return "iPhone";
  if (/iPad/.test(facts.userAgent)) return "iPad";
  if (/Android|Mobile/.test(facts.userAgent)) return "mobile";
  return "desktop";
}

function normalisePlatform(value: string): string {
  if (/^(iphone|ipad|ipod|ios)/i.test(value)) return "iOS";
  if (/^mac/i.test(value)) return "macOS";
  if (/^win/i.test(value)) return "Windows";
  return value;
}

function describeUnknownBrowser(facts: UserAgentFacts): string {
  const brand = (facts.brands ?? []).find((entry) => !/Not.?A.?Brand/i.test(entry.brand));
  if (brand) return `${brand.brand} ${brand.version}`;
  const ios = facts.userAgent.match(/\b(CriOS|FxiOS|EdgiOS|OPiOS)\/(\d+)/);
  if (ios) return `${ios[1]} ${ios[2]}`;
  const safari = facts.userAgent.match(/Version\/(\d+).*Safari\//);
  if (safari) return `Safari ${safari[1]}`;
  const legacy = facts.userAgent.match(/\b(Edg|OPR|Brave|SamsungBrowser|Firefox)\/(\d+)/);
  return legacy ? `${legacy[1]} ${legacy[2]}` : "an unidentified browser";
}

/** Reads the current browser, for client-side use. */
export function currentUserAgentFacts(): UserAgentFacts {
  const candidate = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version: string }>; platform?: string };
    standalone?: boolean;
  };
  const data = candidate.userAgentData;
  return {
    userAgent: navigator.userAgent,
    ...(data?.brands ? { brands: data.brands } : {}),
    ...(data?.platform ? { platform: data.platform } : {}),
    ...(candidate.standalone !== undefined ? { standalone: candidate.standalone } : {}),
  };
}
