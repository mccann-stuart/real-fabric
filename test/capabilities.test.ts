import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthReport } from "../src/client/api";
import { evaluateCapabilities } from "../src/client/hooks/useCapabilities";

const healthyRelay: HealthReport = {
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
