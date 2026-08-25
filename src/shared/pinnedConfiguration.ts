/**
 * H3: one pinned browser, operating system and major version, named in the
 * README. Anything else shows a "not the tested configuration" banner.
 *
 * Specification §14 leaves the final pin to Gate 2 exit, so `status` is
 * `provisional` here. The detection mechanism is real either way; only the
 * declared target moves when Gate 2 signs it off.
 */

export type PinStatus = "provisional" | "signed_off";

export interface PinnedConfiguration {
  browser: "Google Chrome";
  minimumMajorVersion: number;
  platform: "macOS";
  status: PinStatus;
  /** Rendered wherever the pin is quoted, so provisional never reads as verified. */
  note: string;
}

export const PINNED_CONFIGURATION: PinnedConfiguration = {
  browser: "Google Chrome",
  minimumMajorVersion: 141,
  platform: "macOS",
  status: "provisional",
  note: "Provisional pin. Specification §14 assigns the final browser, operating system and major version at Gate 2 exit.",
};

export function describePin(pin: PinnedConfiguration = PINNED_CONFIGURATION): string {
  return `${pin.browser} ${pin.minimumMajorVersion}+ on ${pin.platform}`;
}

export type ConfigurationMatch =
  | { tested: true; browser: string; majorVersion: number; platform: string }
  | {
      tested: false;
      reason: string;
      browser: string;
      majorVersion: number | null;
      platform: string;
    };

export interface UserAgentFacts {
  userAgent: string;
  /** `navigator.userAgentData.brands`, when the browser exposes it. */
  brands?: Array<{ brand: string; version: string }>;
  platform?: string;
}

/**
 * Chromium-family detection from brands where available, falling back to the
 * user-agent string. Deliberately strict: an unrecognised browser is untested,
 * never assumed to be the pin.
 */
export function matchConfiguration(
  facts: UserAgentFacts,
  pin: PinnedConfiguration = PINNED_CONFIGURATION,
): ConfigurationMatch {
  const platform = detectPlatform(facts);
  const chrome = detectChrome(facts);

  if (!chrome) {
    return {
      tested: false,
      reason: `This browser does not identify as ${pin.browser}.`,
      browser: describeUnknownBrowser(facts),
      majorVersion: null,
      platform,
    };
  }
  if (platform !== pin.platform) {
    return {
      tested: false,
      reason: `The tested platform is ${pin.platform}; this session reports ${platform}.`,
      browser: `${chrome.brand} ${chrome.majorVersion}`,
      majorVersion: chrome.majorVersion,
      platform,
    };
  }
  if (chrome.majorVersion < pin.minimumMajorVersion) {
    return {
      tested: false,
      reason: `The tested major version is ${pin.minimumMajorVersion} or later; this session reports ${chrome.majorVersion}.`,
      browser: `${chrome.brand} ${chrome.majorVersion}`,
      majorVersion: chrome.majorVersion,
      platform,
    };
  }
  return {
    tested: true,
    browser: `${chrome.brand} ${chrome.majorVersion}`,
    majorVersion: chrome.majorVersion,
    platform,
  };
}

function detectChrome(facts: UserAgentFacts): { brand: string; majorVersion: number } | null {
  for (const entry of facts.brands ?? []) {
    if (entry.brand !== "Google Chrome") continue;
    const majorVersion = Number.parseInt(entry.version, 10);
    if (Number.isFinite(majorVersion)) return { brand: entry.brand, majorVersion };
  }
  // Edge, Opera and Brave all carry "Chrome/" in the legacy string, so exclude
  // the brands that identify themselves separately before trusting it.
  if (/\b(Edg|OPR|Brave|SamsungBrowser)\//.test(facts.userAgent)) return null;
  const match = facts.userAgent.match(/Chrome\/(\d+)/);
  const majorVersion = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  if (!Number.isFinite(majorVersion)) return null;
  return { brand: "Google Chrome", majorVersion };
}

function detectPlatform(facts: UserAgentFacts): string {
  const declared = facts.platform ?? "";
  if (declared) return normalisePlatform(declared);
  if (/Mac OS X|Macintosh/.test(facts.userAgent)) return "macOS";
  if (/Windows/.test(facts.userAgent)) return "Windows";
  if (/Android/.test(facts.userAgent)) return "Android";
  if (/iPhone|iPad/.test(facts.userAgent)) return "iOS";
  if (/Linux/.test(facts.userAgent)) return "Linux";
  return "an unrecognised platform";
}

function normalisePlatform(value: string): string {
  if (/^mac/i.test(value)) return "macOS";
  if (/^win/i.test(value)) return "Windows";
  return value;
}

function describeUnknownBrowser(facts: UserAgentFacts): string {
  const brand = (facts.brands ?? []).find((entry) => !/Not.?A.?Brand/i.test(entry.brand));
  if (brand) return `${brand.brand} ${brand.version}`;
  const legacy = facts.userAgent.match(/\b(Edg|OPR|Brave|SamsungBrowser|Firefox|Safari)\/(\d+)/);
  return legacy ? `${legacy[1]} ${legacy[2]}` : "an unidentified browser";
}

/** Reads the current browser, for client-side use. */
export function currentUserAgentFacts(): UserAgentFacts {
  const data = (
    navigator as Navigator & {
      userAgentData?: { brands?: Array<{ brand: string; version: string }>; platform?: string };
    }
  ).userAgentData;
  return {
    userAgent: navigator.userAgent,
    ...(data?.brands ? { brands: data.brands } : {}),
    ...(data?.platform ? { platform: data.platform } : {}),
  };
}
