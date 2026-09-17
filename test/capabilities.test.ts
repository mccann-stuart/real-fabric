import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthReport } from "../src/client/api";
import {
  evaluateCapabilities,
  evaluateRequiredBrowserCapabilities,
  groupAudioDevices,
} from "../src/client/hooks/useCapabilities";
import type { SessionState } from "../src/client/session/RoomSession";

const healthyRelay: HealthReport = {
  ok: true,
  service: "real-fabric",
  draft: "16",
  relayEndpoint: "https://relay.example.com",
  relayEndpointName: "example-relay",
  relayCredentialConfigured: true,
  relayCredentialStatus: "available",
  transportVerified: false,
  routingEnforcement: "cooperative",
  discovery: "unknown",
};

describe("Capabilities Evaluation", () => {
  beforeEach(() => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("WebTransport", class {});
    vi.stubGlobal("AudioEncoder", {
      isConfigSupported: vi.fn().mockResolvedValue({ supported: true }),
    });
    vi.stubGlobal("AudioDecoder", {
      isConfigSupported: vi.fn().mockResolvedValue({ supported: true }),
    });
    vi.stubGlobal("AudioData", class {});
    vi.stubGlobal("AudioContext", class {});
    vi.stubGlobal("AudioWorkletNode", class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports an unavailable Opus encoder when AudioEncoder is missing", async () => {
    vi.stubGlobal("AudioEncoder", undefined);
    const result = await evaluateCapabilities(vi.fn().mockResolvedValue(healthyRelay));
    expect(result.opusEncoder).toBe("unavailable");
    expect(result.failure).toBe("transport_unsupported");
  });

  it("returns concrete H3 evidence from the required local browser probes", async () => {
    await expect(evaluateRequiredBrowserCapabilities()).resolves.toEqual({
      state: "ready",
      missing: [],
    });

    vi.stubGlobal("WebTransport", undefined);
    vi.stubGlobal("AudioEncoder", undefined);
    await expect(evaluateRequiredBrowserCapabilities()).resolves.toEqual({
      state: "unavailable",
      missing: ["WebTransport", "WebCodecs Opus encoding"],
    });
  });

  it("names every required probe when the whole browser surface is absent", async () => {
    // H3 admission reads this list, so each of the six required probes has to
    // be able to fail. `isSecureContext` and the AudioWorklet surface are
    // otherwise never driven to their unavailable branch anywhere in the suite.
    vi.stubGlobal("isSecureContext", false);
    for (const capability of [
      "WebTransport",
      "AudioEncoder",
      "AudioDecoder",
      "AudioData",
      "AudioContext",
      "AudioWorkletNode",
    ]) {
      // Deleted rather than stubbed undefined: the playout probe tests for the
      // key with `in`, which a stubbed-undefined value would still satisfy.
      Reflect.deleteProperty(globalThis, capability);
    }

    // Exact and ordered: `arrayContaining` would accept a hardcoded "ready".
    await expect(evaluateRequiredBrowserCapabilities()).resolves.toEqual({
      state: "unavailable",
      missing: [
        "secure context",
        "WebTransport",
        "WebCodecs Opus encoding",
        "WebCodecs Opus decoding",
        "AudioWorklet microphone capture",
        "AudioWorklet playout",
      ],
    });
  });

  it("evaluates capabilities correctly when health report indicates configured and frameable relay", async () => {
    const fetchHealthMock = vi.fn().mockResolvedValue(healthyRelay);
    const result = await evaluateCapabilities(fetchHealthMock);

    expect(fetchHealthMock).toHaveBeenCalledTimes(1);
    expect(result.relay).toBe("ready");
    expect(result.relayEndpoint).toBe("https://relay.example.com");
  });

  it("handles missing relay endpoint with draft_endpoint_missing failure", async () => {
    const mockHealth: HealthReport = {
      ok: true,
      service: "real-fabric",
      draft: "16",
      relayEndpoint: null,
      relayEndpointName: null,
      relayCredentialConfigured: true,
      relayCredentialStatus: "available",
      transportVerified: false,
      routingEnforcement: "cooperative",
      discovery: "unknown",
    };

    const fetchHealthMock = vi.fn().mockResolvedValue(mockHealth);
    const result = await evaluateCapabilities(fetchHealthMock);

    expect(result.relay).toBe("unavailable");
    expect(result.failure).toBe("draft_endpoint_missing");
  });

  it("handles missing relay credential with relay_auth_unavailable failure", async () => {
    const mockHealth: HealthReport = {
      ok: true,
      service: "real-fabric",
      draft: "16",
      relayEndpoint: "https://relay.example.com",
      relayEndpointName: "example-relay",
      relayCredentialConfigured: false,
      relayCredentialStatus: "missing",
      transportVerified: false,
      routingEnforcement: "cooperative",
      discovery: "unknown",
    };

    const fetchHealthMock = vi.fn().mockResolvedValue(mockHealth);
    const result = await evaluateCapabilities(fetchHealthMock);

    expect(result.relay).toBe("unavailable");
    expect(result.failure).toBe("relay_auth_unavailable");
  });

  it("names an expired relay credential without exposing it", async () => {
    const fetchHealthMock = vi.fn().mockResolvedValue({
      ...healthyRelay,
      relayCredentialConfigured: false,
      relayCredentialStatus: "expired",
    } satisfies HealthReport);

    const result = await evaluateCapabilities(fetchHealthMock);

    expect(result.relay).toBe("unavailable");
    expect(result.failure).toBe("relay_auth_unavailable");
    expect(result.relayReason).toBe(
      "The configured relay credential for example-relay has expired.",
    );
  });

  it("handles draft mismatch with draft_mismatch failure", async () => {
    const mockHealth: HealthReport = {
      ok: true,
      service: "real-fabric",
      draft: "999",
      relayEndpoint: "https://relay.example.com",
      relayEndpointName: "example-relay",
      relayCredentialConfigured: true,
      relayCredentialStatus: "available",
      transportVerified: false,
      routingEnforcement: "cooperative",
      discovery: "unknown",
    };

    const fetchHealthMock = vi.fn().mockResolvedValue(mockHealth);
    const result = await evaluateCapabilities(fetchHealthMock);

    expect(result.relay).toBe("unavailable");
    expect(result.failure).toBe("draft_mismatch");
  });

  it("handles fetchHealth rejection with udp_blocked failure", async () => {
    const fetchHealthMock = vi.fn().mockRejectedValue(new Error("Network error"));
    const result = await evaluateCapabilities(fetchHealthMock);

    expect(result.relay).toBe("unavailable");
    expect(result.failure).toBe("udp_blocked");
  });

  it("prevents microphone capture and getUserMedia invocation when capture support is unavailable (SEC-12)", async () => {
    // Stub missing WebCodecs AudioData to make capture support unavailable
    vi.stubGlobal("AudioData", undefined);

    const getUserMediaMock = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: getUserMediaMock,
      },
    });

    const { RoomSession } = await import("../src/client/session/RoomSession");
    const session = new RoomSession({
      session: {
        code: "AAAAAAAAAAAAAAAAAAAA",
        participantId: "test-human",
        rejoinToken: "rejoin-token",
        displayName: "Test Human",
        storedAt: 0,
      },
      presenterMode: false,
    });

    await session.startPublishing();

    // Non-invocation is the security outcome: no microphone hardware is opened.
    expect(getUserMediaMock).not.toHaveBeenCalled();

    // H14: observed through the public subscription rather than the private
    // field, so the banner the participant actually sees is what is asserted.
    const observed: SessionState[] = [];
    const unsubscribe = session.subscribe((state) => {
      observed.push(state);
    });
    unsubscribe();

    const state = observed.at(-1);
    expect(state).toBeDefined();
    expect(state?.capture).toEqual({
      name: "listen_only",
      failure: "microphone_no_device",
      reason: "WebCodecs AudioData is not exposed by this browser.",
    });
    // The failure list is what raises the named §10 banner. Losing the raise()
    // would drop this human to listen-only with no explanation at all.
    expect(state?.failures).toContain("microphone_no_device");
    expect(state?.publishing).toBe(false);

    await session.close();
  });

  describe("groupAudioDevices", () => {
    it("groups audioinput and audiooutput devices and ignores non-audio devices", () => {
      const mockDevices = [
        { deviceId: "mic1", kind: "audioinput", label: "Mic 1", groupId: "g1" },
        { deviceId: "speaker1", kind: "audiooutput", label: "Speaker 1", groupId: "g1" },
        { deviceId: "cam1", kind: "videoinput", label: "Cam 1", groupId: "g2" },
        { deviceId: "mic2", kind: "audioinput", label: "Mic 2", groupId: "g3" },
      ] as MediaDeviceInfo[];

      const grouped = groupAudioDevices(mockDevices);

      expect(grouped).toEqual({
        audioinput: [
          { deviceId: "mic1", kind: "audioinput", label: "Mic 1", groupId: "g1" },
          { deviceId: "mic2", kind: "audioinput", label: "Mic 2", groupId: "g3" },
        ],
        audiooutput: [
          { deviceId: "speaker1", kind: "audiooutput", label: "Speaker 1", groupId: "g1" },
        ],
      });
    });

    it("returns an empty object when given an empty list or devices with no audio kinds", () => {
      expect(groupAudioDevices([])).toEqual({});
      expect(
        groupAudioDevices([
          { deviceId: "cam1", kind: "videoinput", label: "Cam 1", groupId: "g2" },
        ] as MediaDeviceInfo[]),
      ).toEqual({});
    });
  });
});
