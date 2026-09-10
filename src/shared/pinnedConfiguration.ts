/**
 * H3: live audio is admitted only for a named browser target with the required
 * local capabilities. On iPhone the reported OS token is frozen, so observed
 * capabilities are part of admission. Neither identity nor local probes turn
 * an unverified transport into a support claim.
 */

export type PinStatus = "provisional" | "signed_off";
export type ConfigurationStatus =
  | "checking"
  | "supported"
  | "provisional"
  | "readOnly"
  | "unsupported";

export interface BrowserCapabilityEvidence {
  state: "checking" | "ready" | "unavailable";
  /** Required local browser features that failed their concrete probes. */
  missing: string[];
}

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

/**
 * macOS Safari reports a frozen `Mac OS X 10_15_7` token, so no operating-system
 * major can be read from it. The pin therefore names a browser major only, and
 * `minimumPlatformMajorVersion` is deliberately absent rather than guessed.
 */
export const MACOS_SAFARI_CONFIGURATION: PinnedConfiguration = {
  browser: "Safari",
  minimumMajorVersion: 27,
  platform: "macOS",
  device: "desktop",
  status: "provisional",
  note: "Provisional pin. Desktop Safari 27 runs the same capability gates as Chrome, but Gate 1 browser-to-relay and Gate 2 acoustic acceptance remain open.",
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

/**
 * Chrome for iOS renders in WebKit, not Blink, and its user agent carries no
 * `Version/` token. `CriOS` identifies only the shell; concrete browser probes
 * carry the local capability gate. The platform major remains the declared
 * physical-device acceptance target, not a value inferred from the OS token.
 */
export const IOS_CHROME_CONFIGURATION: PinnedConfiguration = {
  browser: "Google Chrome",
  minimumMajorVersion: 141,
  platform: "iOS",
  minimumPlatformMajorVersion: 27,
  device: "iPhone",
  status: "provisional",
  note: "Candidate configuration. Chrome for iOS runs on WebKit, so it inherits the iOS 27 engine rather than the Chrome capability set, and shared WebKit ancestry is not acceptance evidence. No physical iPhone has passed Gate 1 or Gate 2 acceptance in Chrome for iOS.",
};

export const CONFIGURATION_TARGETS = [
  PINNED_CONFIGURATION,
  MACOS_SAFARI_CONFIGURATION,
  IOS_SAFARI_CONFIGURATION,
  IOS_CHROME_CONFIGURATION,
] as const;

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
  /** `navigator.maxTouchPoints`. The only exposed way to tell iPadOS desktop mode from a Mac. */
  maxTouchPoints?: number;
}

/**
 * Deliberately strict user-agent classification. iPhone browsers are checked
 * before the Macintosh token because Apple user-agent strings may contain Mac
 * compatibility tokens. Only top-level Safari and Chrome for iOS are admitted
 * on iPhone; other iOS browsers and embedded web views remain read-only, and
 * a Macintosh user agent reporting touch points is iPadOS in desktop mode
 * rather than an admitted Mac.
 */
export function matchConfiguration(
  facts: UserAgentFacts,
  capabilityEvidence?: BrowserCapabilityEvidence,
): ConfigurationMatch {
  const platform = detectPlatform(facts);
  const device = detectDevice(facts);

  if (device === "iPhone") return matchIphone(facts, platform, capabilityEvidence);

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

  const desktopSafari = detectDesktopSafari(facts);
  if (desktopSafari && platform === MACOS_SAFARI_CONFIGURATION.platform) {
    // iPadOS Safari requests desktop sites by default and then reports the same
    // Macintosh token as a Mac. Touch points are the only exposed difference,
    // and Apple ships no touch-screen Mac, so a touch-capable "Mac" fails closed.
    if ((facts.maxTouchPoints ?? 0) > 1) {
      return result({
        status: "readOnly",
        browser: `Safari ${desktopSafari.majorVersion}`,
        browserMajorVersion: desktopSafari.majorVersion,
        platform,
        device: "iPad",
        target: null,
        reasons: [
          "This reports a Macintosh user agent with touch points, which is iPadOS Safari in desktop mode. iPadOS is outside the admitted device matrix.",
        ],
      });
    }
    if (desktopSafari.majorVersion < MACOS_SAFARI_CONFIGURATION.minimumMajorVersion) {
      return result({
        status: "unsupported",
        browser: `Safari ${desktopSafari.majorVersion}`,
        browserMajorVersion: desktopSafari.majorVersion,
        platform,
        device,
        target: MACOS_SAFARI_CONFIGURATION,
        reasons: [
          `The macOS Safari floor is ${MACOS_SAFARI_CONFIGURATION.minimumMajorVersion}; this session reports ${desktopSafari.majorVersion}.`,
        ],
      });
    }
    return result({
      status: MACOS_SAFARI_CONFIGURATION.status === "signed_off" ? "supported" : "provisional",
      browser: `Safari ${desktopSafari.majorVersion}`,
      browserMajorVersion: desktopSafari.majorVersion,
      platform,
      device,
      target: MACOS_SAFARI_CONFIGURATION,
      reasons: [MACOS_SAFARI_CONFIGURATION.note],
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
        : `This browser does not identify as ${PINNED_CONFIGURATION.browser} or top-level Safari.`,
    ],
  });
}

function matchIphone(
  facts: UserAgentFacts,
  platform: string,
  capabilityEvidence?: BrowserCapabilityEvidence,
): ConfigurationMatch {
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

  const chrome = detectIphoneChrome(facts);
  if (chrome) {
    return matchIphoneChrome(chrome, platform, osMajorVersion, capabilityEvidence);
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
        "This is not top-level Safari or Chrome for iOS. Other iOS browsers and embedded web views remain read-only.",
      ],
    });
  }

  const minimumOs = IOS_SAFARI_CONFIGURATION.minimumPlatformMajorVersion ?? 27;
  if (safari.majorVersion < IOS_SAFARI_CONFIGURATION.minimumMajorVersion) {
    return result({
      status: "readOnly",
      browser: `Safari ${safari.majorVersion}`,
      browserMajorVersion: safari.majorVersion,
      platform,
      osMajorVersion,
      device: "iPhone",
      target: IOS_SAFARI_CONFIGURATION,
      reasons: [
        `The working-audio browser floor is Safari ${IOS_SAFARI_CONFIGURATION.minimumMajorVersion}; this session reports Safari ${safari.majorVersion}.`,
      ],
    });
  }

  const capabilityResult = matchIphoneCapabilityEvidence({
    evidence: capabilityEvidence,
    browser: `Safari ${safari.majorVersion}`,
    browserMajorVersion: safari.majorVersion,
    platform,
    osMajorVersion,
    minimumOs,
    target: IOS_SAFARI_CONFIGURATION,
  });
  if (capabilityResult) return capabilityResult;

  // Safari deliberately freezes the iPhone OS token at an iOS 18 value. When
  // the real local capability probes ran, that compatibility token is not an
  // operating-system version gate. Calls without capability evidence retain
  // the conservative legacy behaviour for non-browser consumers.
  if (capabilityEvidence === undefined && (osMajorVersion === null || osMajorVersion < minimumOs)) {
    return result({
      status: "readOnly",
      browser: `Safari ${safari.majorVersion}`,
      browserMajorVersion: safari.majorVersion,
      platform,
      osMajorVersion,
      device: "iPhone",
      target: IOS_SAFARI_CONFIGURATION,
      reasons: [
        "Required browser capability evidence was not supplied, so the frozen iPhone OS user-agent token cannot admit live audio by itself.",
      ],
    });
  }

  const frozenOsToken = osMajorVersion === null || osMajorVersion < minimumOs;
  const initiallyTestedMajor = safari.majorVersion === IOS_SAFARI_CONFIGURATION.minimumMajorVersion;
  const acceptanceReason = initiallyTestedMajor
    ? IOS_SAFARI_CONFIGURATION.note
    : `Safari ${safari.majorVersion} meets the browser floor but has not been added to the physical-device acceptance matrix.`;
  return result({
    status: "provisional",
    browser: `Safari ${safari.majorVersion}`,
    browserMajorVersion: safari.majorVersion,
    platform,
    osMajorVersion,
    device: "iPhone",
    target: IOS_SAFARI_CONFIGURATION,
    reasons: [
      frozenOsToken
        ? `${describeIphoneOsCompatibilityToken(osMajorVersion)} Safari ${safari.majorVersion} passed every required local browser capability probe. ${acceptanceReason}`
        : acceptanceReason,
    ],
  });
}

/**
 * Chrome for iOS is a shell around WebKit, so the `CriOS` major cannot imply a
 * Blink capability set. The browser major identifies the admitted shell; real
 * WebTransport, Opus, capture and playout probes decide local eligibility.
 */
function matchIphoneChrome(
  chrome: { majorVersion: number },
  platform: string,
  osMajorVersion: number | null,
  capabilityEvidence?: BrowserCapabilityEvidence,
): ConfigurationMatch {
  const minimumOs = IOS_CHROME_CONFIGURATION.minimumPlatformMajorVersion ?? 27;
  const browser = `Google Chrome ${chrome.majorVersion}`;
  if (chrome.majorVersion < IOS_CHROME_CONFIGURATION.minimumMajorVersion) {
    return result({
      status: "readOnly",
      browser,
      browserMajorVersion: chrome.majorVersion,
      platform,
      osMajorVersion,
      device: "iPhone",
      target: IOS_CHROME_CONFIGURATION,
      reasons: [
        `The working-audio browser floor is Chrome ${IOS_CHROME_CONFIGURATION.minimumMajorVersion}; this session reports Chrome ${chrome.majorVersion}.`,
      ],
    });
  }

  const capabilityResult = matchIphoneCapabilityEvidence({
    evidence: capabilityEvidence,
    browser,
    browserMajorVersion: chrome.majorVersion,
    platform,
    osMajorVersion,
    minimumOs,
    target: IOS_CHROME_CONFIGURATION,
  });
  if (capabilityResult) return capabilityResult;

  if (capabilityEvidence === undefined && (osMajorVersion === null || osMajorVersion < minimumOs)) {
    return result({
      status: "readOnly",
      browser,
      browserMajorVersion: chrome.majorVersion,
      platform,
      osMajorVersion,
      device: "iPhone",
      target: IOS_CHROME_CONFIGURATION,
      reasons: [
        "Required browser capability evidence was not supplied, so the iPhone OS user-agent token cannot admit live audio by itself.",
      ],
    });
  }

  const frozenOsToken = osMajorVersion === null || osMajorVersion < minimumOs;

  return result({
    status: "provisional",
    browser,
    browserMajorVersion: chrome.majorVersion,
    platform,
    osMajorVersion,
    device: "iPhone",
    target: IOS_CHROME_CONFIGURATION,
    reasons: [
      frozenOsToken
        ? `${describeIphoneOsCompatibilityToken(osMajorVersion)} Chrome for iOS ${chrome.majorVersion} passed every required local browser capability probe. ${IOS_CHROME_CONFIGURATION.note}`
        : IOS_CHROME_CONFIGURATION.note,
    ],
  });
}

function matchIphoneCapabilityEvidence(input: {
  evidence: BrowserCapabilityEvidence | undefined;
  browser: string;
  browserMajorVersion: number;
  platform: string;
  osMajorVersion: number | null;
  minimumOs: number;
  target: PinnedConfiguration;
}): ConfigurationMatch | null {
  if (!input.evidence || input.evidence.state === "ready") return null;

  const frozenTokenReason =
    input.osMajorVersion === null || input.osMajorVersion < input.minimumOs
      ? `${describeIphoneOsCompatibilityToken(input.osMajorVersion)} `
      : "";
  if (input.evidence.state === "checking") {
    return result({
      status: "checking",
      browser: input.browser,
      browserMajorVersion: input.browserMajorVersion,
      platform: input.platform,
      osMajorVersion: input.osMajorVersion,
      device: "iPhone",
      target: input.target,
      reasons: [
        `${frozenTokenReason}Testing the required WebTransport, Opus, capture and playout capabilities before enabling audio.`,
      ],
    });
  }

  return result({
    status: "readOnly",
    browser: input.browser,
    browserMajorVersion: input.browserMajorVersion,
    platform: input.platform,
    osMajorVersion: input.osMajorVersion,
    device: "iPhone",
    target: input.target,
    reasons: [
      `${frozenTokenReason}Required local browser capabilities are unavailable: ${input.evidence.missing.join(", ") || "an unidentified capability"}.`,
    ],
  });
}

function describeIphoneOsCompatibilityToken(osMajorVersion: number | null): string {
  return osMajorVersion === null
    ? "This browser does not expose the current iOS version in its user-agent string."
    : `The reported iOS ${osMajorVersion} user-agent value is a frozen compatibility token, not reliable evidence of the phone's current operating-system version.`;
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

/**
 * Top-level desktop Safari only. Every Chromium browser also carries a
 * `Safari/` build token, so the Chromium and Gecko brands are excluded first,
 * as is any browser exposing `userAgentData` brands, which WebKit does not.
 */
function detectDesktopSafari(facts: UserAgentFacts): { majorVersion: number } | null {
  // `Mobile/` is the iPhone build token, handled by the iPhone branch above.
  if (/Mobile\//.test(facts.userAgent)) return null;
  if (/\b(Chrome|Chromium|Edg|OPR|Brave|SamsungBrowser|Firefox)\//.test(facts.userAgent)) {
    return null;
  }
  if ((facts.brands ?? []).some((entry) => !/Not.?A.?Brand/i.test(entry.brand))) return null;
  if (!/Safari\//.test(facts.userAgent)) return null;
  const match = facts.userAgent.match(/Version\/(\d+)/);
  const majorVersion = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(majorVersion) ? { majorVersion } : null;
}

/**
 * Chrome for iOS reports `CriOS/<chrome major>` and no `Version/` token, so the
 * engine version is never readable from it. Only the shell major is returned.
 */
function detectIphoneChrome(facts: UserAgentFacts): { majorVersion: number } | null {
  const match = facts.userAgent.match(/CriOS\/(\d+)/);
  const majorVersion = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(majorVersion) ? { majorVersion } : null;
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
  // This module is also compiled for the Worker, whose Navigator type exposes
  // neither the DOM touch-point count nor these non-standard fields.
  const candidate = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version: string }>; platform?: string };
    standalone?: boolean;
    maxTouchPoints?: number;
  };
  const data = candidate.userAgentData;
  return {
    userAgent: navigator.userAgent,
    ...(data?.brands ? { brands: data.brands } : {}),
    ...(data?.platform ? { platform: data.platform } : {}),
    ...(candidate.standalone !== undefined ? { standalone: candidate.standalone } : {}),
    ...(typeof candidate.maxTouchPoints === "number"
      ? { maxTouchPoints: candidate.maxTouchPoints }
      : {}),
  };
}
