import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthReport } from "../src/client/api";
import { checkOpus, evaluateCapabilities } from "../src/client/hooks/useCapabilities";

describe("Capabilities Evaluation", () => {
  const originalAudioEncoder = globalThis.AudioEncoder;
  const originalIsSecureContext = globalThis.isSecureContext;
  const originalWebTransport = globalThis.WebTransport;
  const originalAudioData = globalThis.AudioData;
  const originalMediaStreamTrackProcessor = (
    globalThis as unknown as { MediaStreamTrackProcessor?: unknown }
  ).MediaStreamTrackProcessor;

  beforeEach(() => {
    // Setup browser globals for test environment
    globalThis.isSecureContext = true;
    // @ts-expect-error stub WebTransport
    globalThis.WebTransport = class {};
    // @ts-expect-error stub AudioEncoder
    globalThis.AudioEncoder = {
      isConfigSupported: vi.fn().mockResolvedValue({ supported: true }),
    };
    // @ts-expect-error stub AudioData
    globalThis.AudioData = class {};
    (globalThis as unknown as { MediaStreamTrackProcessor: unknown }).MediaStreamTrackProcessor =
      class {};
  });

  afterEach(() => {
    if (originalAudioEncoder !== undefined) {
      globalThis.AudioEncoder = originalAudioEncoder;
    } else {
      // @ts-expect-error cleanup mock
      delete globalThis.AudioEncoder;
    }

    if (originalIsSecureContext !== undefined) {
      globalThis.isSecureContext = originalIsSecureContext;
    } else {
      // @ts-expect-error cleanup mock
      delete globalThis.isSecureContext;
    }

    if (originalWebTransport !== undefined) {
      globalThis.WebTransport = originalWebTransport;
    } else {
      // @ts-expect-error cleanup mock
      delete globalThis.WebTransport;
    }

    if (originalAudioData !== undefined) {
      globalThis.AudioData = originalAudioData;
    } else {
      // @ts-expect-error cleanup mock
      delete globalThis.AudioData;
    }

    if (originalMediaStreamTrackProcessor !== undefined) {
      (globalThis as unknown as { MediaStreamTrackProcessor: unknown }).MediaStreamTrackProcessor =
        originalMediaStreamTrackProcessor;
    } else {
      delete (globalThis as unknown as { MediaStreamTrackProcessor?: unknown })
        .MediaStreamTrackProcessor;
    }
  });

  it("returns unavailable for checkOpus when AudioEncoder is missing", async () => {
    // @ts-expect-error deleting for test
    delete globalThis.AudioEncoder;
    const result = await checkOpus();
    expect(result).toBe("unavailable");
  });

  it("evaluates capabilities correctly when health report indicates configured and frameable relay", async () => {
    const mockHealth: HealthReport = {
      ok: true,
      service: "real-fabric",
      draft: "16",
      relayEndpoint: "https://relay.example.com",
      relayEndpointName: "example-relay",
      relayCredentialConfigured: true,
      transportVerified: false,
      routingEnforcement: "cooperative",
      discovery: "unknown",
    };

    const fetchHealthMock = vi.fn().mockResolvedValue(mockHealth);
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
      transportVerified: false,
      routingEnforcement: "cooperative",
      discovery: "unknown",
    };

    const fetchHealthMock = vi.fn().mockResolvedValue(mockHealth);
    const result = await evaluateCapabilities(fetchHealthMock);

    expect(result.relay).toBe("unavailable");
    expect(result.failure).toBe("relay_auth_unavailable");
  });

  it("handles draft mismatch with draft_mismatch failure", async () => {
    const mockHealth: HealthReport = {
      ok: true,
      service: "real-fabric",
      draft: "999",
      relayEndpoint: "https://relay.example.com",
      relayEndpointName: "example-relay",
      relayCredentialConfigured: true,
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
});
