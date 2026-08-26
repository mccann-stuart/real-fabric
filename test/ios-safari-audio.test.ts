import { describe, expect, it, vi } from "vitest";
import {
  type OpusEncoderConfig,
  probeOpusEncoderSupport,
} from "../src/client/audio/CaptureController";
import {
  type ForegroundAudioEnvironment,
  ForegroundAudioLifecycle,
} from "../src/client/audio/ForegroundAudioLifecycle";
import { encodeAudioObject } from "../src/client/audio/frame";
import type { MixerGraph } from "../src/client/audio/MixerGraph";
import { PlaybackDeduplicator } from "../src/client/audio/PlaybackDeduplicator";
import { TrackPlayer } from "../src/client/audio/TrackPlayer";
import {
  checkOpusDecoder,
  classifyTransportCapabilities,
} from "../src/client/hooks/useCapabilities";
import { RoomSession, type SessionPhase } from "../src/client/session/RoomSession";
import { requiredTransportReliabilityError } from "../src/client/transport/MoqTransportAdapter";
import { probeRelayReachability } from "../src/client/transport/NetworkProbe";
import {
  IOS_CHROME_CONFIGURATION,
  IOS_SAFARI_CONFIGURATION,
  matchConfiguration,
} from "../src/shared/pinnedConfiguration";

const SAFARI_27 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/619.1.12 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";

describe("iOS 27 Safari configuration floor", () => {
  it("recognises top-level iPhone Safari 27 before Macintosh compatibility tokens", () => {
    const match = matchConfiguration({ userAgent: SAFARI_27, platform: "MacIntel" });
    expect(match).toMatchObject({
      status: "provisional",
      liveAudioEligible: true,
      browser: "Safari 27",
      browserMajorVersion: 27,
      platform: "iOS",
      osMajorVersion: 27,
      device: "iPhone",
      target: IOS_SAFARI_CONFIGURATION,
    });
  });

  it("keeps Safari 26 below the audio floor and later majors explicitly provisional", () => {
    const belowFloor = [
      SAFARI_27.replace("CPU iPhone OS 27_0", "CPU iPhone OS 26_0"),
      SAFARI_27.replace("Version/27.0", "Version/26.0"),
    ];
    for (const userAgent of belowFloor) {
      const match = matchConfiguration({ userAgent, platform: "iPhone" });
      expect(match.status).toBe("readOnly");
      expect(match.liveAudioEligible).toBe(false);
      expect(match.reasons.join(" ")).toMatch(/floor is iOS 27 and Safari 27/i);
    }

    const safari28 = matchConfiguration({
      userAgent: SAFARI_27.replace("Version/27.0", "Version/28.0"),
      platform: "iPhone",
    });
    expect(safari28.status).toBe("provisional");
    expect(safari28.liveAudioEligible).toBe(true);
    expect(safari28.reasons.join(" ")).toMatch(/not been added.*acceptance matrix/i);
  });

  it("leaves alternative iOS browsers, web views and Home Screen mode read-only", () => {
    for (const token of ["FxiOS", "EdgiOS", "OPiOS"] as const) {
      const alternative = matchConfiguration({
        userAgent: SAFARI_27.replace("Version/27.0", `${token}/141.0.0.0`),
        platform: "iPhone",
      });
      expect(alternative.status).toBe("readOnly");
      expect(alternative.browser).toContain(token);
    }

    const webView = matchConfiguration({
      userAgent: SAFARI_27.replace(" Version/27.0", "").replace(" Safari/604.1", ""),
      platform: "iPhone",
    });
    expect(webView.status).toBe("readOnly");
    expect(webView.liveAudioEligible).toBe(false);

    const standalone = matchConfiguration({
      userAgent: SAFARI_27,
      platform: "iPhone",
      standalone: true,
    });
    expect(standalone.status).toBe("readOnly");
    expect(standalone.reasons.join(" ")).toMatch(/Home Screen/i);
  });
});

describe("Chrome for iOS configuration floor", () => {
  // Chrome for iOS reports CriOS and carries no Version/ token at all.
  const CHROME_IOS_141 = SAFARI_27.replace("Version/27.0", "CriOS/141.0.7390.35");

  it("admits top-level Chrome for iOS at the floor as provisional", () => {
    const match = matchConfiguration({ userAgent: CHROME_IOS_141, platform: "iPhone" });
    expect(match).toMatchObject({
      status: "provisional",
      liveAudioEligible: true,
      browser: "Google Chrome 141",
      browserMajorVersion: 141,
      platform: "iOS",
      osMajorVersion: 27,
      device: "iPhone",
      target: IOS_CHROME_CONFIGURATION,
    });
  });

  it("records that Chrome for iOS inherits WebKit rather than a Blink capability set", () => {
    const match = matchConfiguration({ userAgent: CHROME_IOS_141, platform: "iPhone" });
    expect(match.reasons.join(" ")).toMatch(/WebKit/i);
    expect(match.reasons.join(" ")).not.toMatch(/verified|supported browser/i);
  });

  it("keeps Chrome for iOS below either floor read-only and names the floor it missed", () => {
    const belowOs = matchConfiguration({
      userAgent: CHROME_IOS_141.replace("CPU iPhone OS 27_0", "CPU iPhone OS 26_0"),
      platform: "iPhone",
    });
    expect(belowOs.status).toBe("readOnly");
    expect(belowOs.liveAudioEligible).toBe(false);
    expect(belowOs.reasons.join(" ")).toMatch(/floor is iOS 27 and Chrome 141/i);

    const belowChrome = matchConfiguration({
      userAgent: CHROME_IOS_141.replace("CriOS/141", "CriOS/140"),
      platform: "iPhone",
    });
    expect(belowChrome.status).toBe("readOnly");
    expect(belowChrome.liveAudioEligible).toBe(false);
    expect(belowChrome.reasons.join(" ")).toMatch(/reports iOS 27 and Chrome 140/i);
  });

  it("fails closed when the iOS major cannot be read from a Chrome for iOS agent", () => {
    const match = matchConfiguration({
      userAgent: CHROME_IOS_141.replace("CPU iPhone OS 27_0 like Mac OS X", "like Mac OS X"),
      platform: "iPhone",
    });
    expect(match.status).toBe("readOnly");
    expect(match.liveAudioEligible).toBe(false);
    expect(match.reasons.join(" ")).toMatch(/iOS version could not be identified/i);
  });

  it("does not admit Chrome for iOS installed to the Home Screen", () => {
    const match = matchConfiguration({
      userAgent: CHROME_IOS_141,
      platform: "iPhone",
      standalone: true,
    });
    expect(match.status).toBe("readOnly");
    expect(match.reasons.join(" ")).toMatch(/Home Screen/i);
  });

  it("never admits desktop Chrome's CriOS-free agent through the iPhone branch", () => {
    // Desktop Chrome on macOS must still match the desktop pin, not this one.
    const desktop = matchConfiguration({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      brands: [{ brand: "Google Chrome", version: "141" }],
      platform: "macOS",
    });
    expect(desktop.target).not.toBe(IOS_CHROME_CONFIGURATION);
    expect(desktop.device).toBe("desktop");
  });
});

describe("foreground audio standards", () => {
  it("sets play-and-record, acquires the optional wake lock and reports interruption", async () => {
    const audioSession = new FakeAudioSession();
    const sentinel = new FakeWakeLockSentinel();
    const interrupted = vi.fn();
    const lifecycle = new ForegroundAudioLifecycle(
      { onInterrupted: interrupted },
      {
        audioSession,
        wakeLock: { request: vi.fn().mockResolvedValue(sentinel) },
      },
    );

    await lifecycle.activate();
    expect(audioSession.type).toBe("play-and-record");
    expect(lifecycle.snapshot()).toMatchObject({ audioSession: "active", wakeLock: "active" });

    audioSession.state = "interrupted";
    audioSession.dispatchEvent(new Event("statechange"));
    expect(interrupted).toHaveBeenCalledWith(expect.stringMatching(/interrupted/i));

    await lifecycle.releaseWakeLock("hidden");
    expect(sentinel.release).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot().wakeLock).toBe("released");
  });

  it("does not block audio activation when Screen Wake Lock is denied", async () => {
    const environment: ForegroundAudioEnvironment = {
      audioSession: null,
      wakeLock: { request: vi.fn().mockRejectedValue(new Error("battery policy")) },
    };
    const lifecycle = new ForegroundAudioLifecycle({}, environment);
    await expect(lifecycle.activate()).resolves.toBeUndefined();
    expect(lifecycle.snapshot()).toMatchObject({
      audioSession: "not_exposed",
      wakeLock: "denied",
    });
  });

  it("enters resume-required and tears down audio without closing room membership", async () => {
    const session = new RoomSession({
      session: {
        code: "AAAAAAAAAAAAAAAAAAAA",
        participantId: "participant-1",
        rejoinToken: "rejoin-token",
        displayName: "Test participant",
        storedAt: 0,
      },
      presenterMode: false,
    });
    const internal = session as unknown as {
      phase: SessionPhase;
      publishing: boolean;
      capture: { stop: () => Promise<void> };
      transport: { close: (reason: string) => Promise<void> };
      mixer: { close: () => Promise<void> };
    };
    internal.phase = { name: "live" };
    internal.publishing = true;
    internal.capture.stop = vi.fn().mockResolvedValue(undefined);
    internal.transport.close = vi.fn().mockResolvedValue(undefined);
    internal.mixer.close = vi.fn().mockResolvedValue(undefined);

    await session.interruptAudio("Safari moved the room to the background.");

    let phase: SessionPhase = { name: "idle" };
    let captureName = "";
    const unsubscribe = session.subscribe((state) => {
      phase = state.phase;
      captureName = state.capture.name;
    });
    expect(phase).toMatchObject({ name: "resume_required" });
    expect(captureName).toBe("resume_required");
    expect(internal.transport.close).toHaveBeenCalledWith("foreground audio interrupted");
    unsubscribe();
    await session.close();
  });
});

describe("HTTP/3-only and Opus capability probes", () => {
  it("rejects a reliable-only WebTransport probe and records low-latency fallback truthfully", async () => {
    const reliableOnly = await probeRelayReachability({
      relayEndpoint: "https://relay.example.invalid",
      openWebTransport: () => ({
        ready: Promise.resolve(),
        close: () => undefined,
        reliability: "reliable-only",
        congestionControl: "default",
      }),
    });
    expect(reliableOnly).toMatchObject({
      state: "reliable_only",
      reliability: "reliable-only",
      congestionControl: "default",
    });
    expect(reliableOnly.detail).toMatch(/no.*HTTP\/2|will not carry audio over HTTP\/2/i);
    expect(classifyTransportCapabilities(reliableOnly)).toEqual({
      webTransportReliability: "unavailable",
      lowLatencyCongestionControl: "unavailable",
    });

    let reliability: "pending" | "supports-unreliable" = "pending";
    let congestionControl: "default" | "low-latency" = "default";
    const h3 = await probeRelayReachability({
      relayEndpoint: "https://relay.example.invalid",
      openWebTransport: () => ({
        ready: Promise.resolve().then(() => {
          reliability = "supports-unreliable";
          congestionControl = "low-latency";
        }),
        close: () => undefined,
        get reliability() {
          return reliability;
        },
        get congestionControl() {
          return congestionControl;
        },
      }),
    });
    expect(h3).toMatchObject({
      state: "reachable",
      reliability: "supports-unreliable",
      congestionControl: "low-latency",
    });
    expect(classifyTransportCapabilities(h3)).toEqual({
      webTransportReliability: "ready",
      lowLatencyCongestionControl: "ready",
    });
  });

  it("refuses reliable-only or unreported reliability inside the MOQT adapter boundary", () => {
    expect(requiredTransportReliabilityError("supports-unreliable", "relay.example")).toBeNull();
    expect(requiredTransportReliabilityError("reliable-only", "relay.example")).toMatchObject({
      code: "reliable_transport",
    });
    expect(requiredTransportReliabilityError("Not exposed", "relay.example")).toMatchObject({
      code: "protocol_error",
    });
  });

  it("retains only Opus voice options echoed by isConfigSupported", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "AudioEncoder");
    const required: OpusEncoderConfig = {
      codec: "opus",
      sampleRate: 48_000,
      numberOfChannels: 1,
      bitrate: 32_000,
    };
    const audioEncoder = Object.assign(function AudioEncoder() {}, {
      isConfigSupported: vi.fn().mockImplementation(async (candidate: OpusEncoderConfig) => ({
        supported: true,
        config: candidate.opus
          ? {
              ...required,
              opus: {
                ...candidate.opus,
                signal: undefined,
                usedtx: undefined,
              },
            }
          : required,
      })),
    });
    Object.defineProperty(globalThis, "AudioEncoder", {
      configurable: true,
      value: audioEncoder,
    });
    try {
      const probe = await probeOpusEncoderSupport();
      expect(probe.supported).toBe(true);
      expect(probe.configuration?.opus).toEqual({ frameDuration: 20_000, application: "voip" });
      expect(probe.dtx.exposed).toBe(false);
      expect(probe.application).toEqual({ exposed: true, value: "voip" });
      expect(probe.signal.exposed).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, "AudioEncoder", original);
      else Reflect.deleteProperty(globalThis, "AudioEncoder");
    }
  });

  it("reports rejected Opus encoder and decoder configurations as unavailable", async () => {
    const originalEncoder = Object.getOwnPropertyDescriptor(globalThis, "AudioEncoder");
    const originalDecoder = Object.getOwnPropertyDescriptor(globalThis, "AudioDecoder");
    const audioEncoder = Object.assign(function AudioEncoder() {}, {
      isConfigSupported: vi.fn().mockResolvedValue({ supported: false }),
    });
    const audioDecoder = Object.assign(function AudioDecoder() {}, {
      isConfigSupported: vi.fn().mockResolvedValue({ supported: false }),
    });
    Object.defineProperty(globalThis, "AudioEncoder", {
      configurable: true,
      value: audioEncoder,
    });
    Object.defineProperty(globalThis, "AudioDecoder", {
      configurable: true,
      value: audioDecoder,
    });
    try {
      await expect(probeOpusEncoderSupport()).resolves.toMatchObject({ supported: false });
      await expect(checkOpusDecoder()).resolves.toBe("unavailable");
    } finally {
      if (originalEncoder) Object.defineProperty(globalThis, "AudioEncoder", originalEncoder);
      else Reflect.deleteProperty(globalThis, "AudioEncoder");
      if (originalDecoder) Object.defineProperty(globalThis, "AudioDecoder", originalDecoder);
      else Reflect.deleteProperty(globalThis, "AudioDecoder");
    }
  });

  it("retains playback deduplication when a player is rebuilt for resume", () => {
    const dedupe = new PlaybackDeduplicator();
    const mixer = {
      addTrack: vi.fn(),
      removeTrack: vi.fn(),
      pushSamples: vi.fn(),
      setRatio: vi.fn(),
      flush: vi.fn(),
    } as unknown as MixerGraph;
    const payload = encodeAudioObject(
      { participantHash: 1, mediaTimestamp: 1_000, sequence: 1 },
      new Uint8Array([1, 2]),
    );
    const first = new TrackPlayer("participant", "track", mixer, {}, dedupe);
    first.accept(1, 1, payload, 1_000);
    expect(first.buffer.depth).toBe(1);
    first.close();

    const resumed = new TrackPlayer("participant", "track", mixer, {}, dedupe);
    resumed.accept(1, 1, payload, 1_020);
    expect(resumed.buffer.depth).toBe(0);
  });
});

class FakeAudioSession extends EventTarget {
  type = "auto";
  state: "inactive" | "active" | "interrupted" = "active";
}

class FakeWakeLockSentinel extends EventTarget {
  released = false;
  release = vi.fn(async () => {
    this.released = true;
    this.dispatchEvent(new Event("release"));
  });
}
