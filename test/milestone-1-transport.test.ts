import { describe, expect, it } from "vitest";
import { ReconnectionPolicy, TERMINAL_AFTER_MS } from "../src/client/session/ReconnectionPolicy";
import {
  draftsFramedByClient,
  MoqTransportAdapter,
  MoqTransportError,
} from "../src/client/transport/MoqTransportAdapter";
import { HOTSPOT_REMEDIATION, probeRelayReachability } from "../src/client/transport/NetworkProbe";
import { asMoqDraft, MOQT_DRAFTS, PINNED_MOQT_DRAFT } from "../src/shared/contracts";
import { credentialLifetimeMs, mintRelayCredential } from "../src/worker/relayCredential";

/**
 * §11.2 milestone 1: live transport unblocking and relay interoperability.
 */

describe("M1 — draft registry and relay interoperability", () => {
  it("frames exactly the drafts the pinned client library implements", () => {
    // Read from the library, so bumping moqtail moves this rather than a
    // hand-maintained assertion drifting away from the wire encoder.
    expect(draftsFramedByClient()).toEqual(["16"]);
  });

  it("pins the product to draft 20 even while the client cannot frame it", () => {
    expect(PINNED_MOQT_DRAFT).toBe("20");
    expect(draftsFramedByClient()).not.toContain(PINNED_MOQT_DRAFT);
  });

  it("recognises every draft in the registry and refuses invented ones", () => {
    for (const draft of MOQT_DRAFTS) expect(asMoqDraft(draft)).toBe(draft);
    expect(asMoqDraft("21")).toBeNull();
    expect(asMoqDraft("")).toBeNull();
  });

  it("refuses a draft it cannot frame by name, and never downgrades to one it can", async () => {
    const adapter = new MoqTransportAdapter();
    const error = await adapter
      .connect("https://draft-20.example.invalid", "credential", "20")
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(MoqTransportError);
    const failure = error as MoqTransportError;
    expect(failure.code).toBe("draft_mismatch");
    // H1: both sides named, and the absence of a fallback stated outright.
    expect(failure.message).toContain("moqt-16");
    expect(failure.message).toContain("draft 20");
    expect(failure.message).toMatch(/no downgrade was attempted/i);
    // Nothing was negotiated, so nothing may claim it was.
    expect(adapter.sessionStats().negotiation).toBeNull();
    expect(adapter.sessionStats().state).not.toBe("connected");
  });

  it("refuses an unknown draft before touching the network", async () => {
    const adapter = new MoqTransportAdapter();
    await expect(
      adapter.connect("https://relay.example.invalid", "credential", "99"),
    ).rejects.toMatchObject({ code: "draft_unavailable" });
  });

  it("reports a missing WebTransport capability ahead of anything further out", async () => {
    // The nearer cause wins: a browser without WebTransport cannot be fixed by
    // minting a credential, and its recovery advice is different.
    expect("WebTransport" in globalThis).toBe(false);
    const adapter = new MoqTransportAdapter();
    await expect(
      adapter.connect("https://draft-16.example.invalid", "", "16"),
    ).rejects.toMatchObject({ code: "draft_unavailable" });
    expect(adapter.sessionStats().negotiation).toBeNull();
  });

  it("attempts no connection without a minted relay credential", async () => {
    // Past the capability gate, an unminted credential still stops the attempt
    // rather than connecting anonymously and hoping the relay is open.
    Object.defineProperty(globalThis, "WebTransport", {
      value: class {},
      configurable: true,
    });
    try {
      const adapter = new MoqTransportAdapter();
      await expect(
        adapter.connect("https://draft-16.example.invalid", "", "16"),
      ).rejects.toMatchObject({ code: "relay_unavailable" });
      expect(adapter.sessionStats().negotiation).toBeNull();
      expect(adapter.sessionStats().state).not.toBe("connected");
    } finally {
      Reflect.deleteProperty(globalThis, "WebTransport");
    }
  });

  it("reports Not exposed for round-trip time rather than zero", () => {
    // H15: a browser that reports nothing must never read as a perfect link.
    expect(new MoqTransportAdapter().sessionStats().transportRttMs).toBe("Not exposed");
  });

  it("mints a scoped, expiring credential without requiring a live endpoint", async () => {
    const now = Date.now();
    const expiresAt = now + 60_000;
    const credential = await mintRelayCredential(
      {
        room: "demo/ROOM",
        participant: "participant",
        publish: "demo/ROOM/audio/participant",
        subscribe: "demo/ROOM",
        expiresAt,
      },
      undefined,
    );
    expect(credential).toMatch(/^v1\.unsigned\./);
    expect(credentialLifetimeMs(expiresAt, now)).toBe(60_000);
  });
});

describe("M1 — pre-flight HTTP/3 and QUIC probe", () => {
  const reachable = () => ({ ready: Promise.resolve(), close: () => undefined });
  const refused = () => ({
    ready: Promise.reject(new Error("connection refused")),
    close: () => undefined,
  });

  it("does not run when no relay endpoint is configured", async () => {
    const result = await probeRelayReachability({ relayEndpoint: null });
    expect(result.state).toBe("not_run");
    expect(result.remediation).toBeNull();
  });

  it("reports the network path without claiming a MOQT session works", async () => {
    const result = await probeRelayReachability({
      relayEndpoint: "https://draft-16.example.invalid",
      openWebTransport: reachable,
      probeControlPlane: async () => true,
    });
    expect(result.state).toBe("reachable");
    expect(result.detail).toMatch(/not that a MOQT session succeeds/i);
  });

  it("separates filtered UDP from a dead connection using the TCP leg", async () => {
    // §11.2: HTTPS works, HTTP/3 does not — the venue-network signature.
    const filtered = await probeRelayReachability({
      relayEndpoint: "https://draft-16.example.invalid",
      openWebTransport: refused,
      probeControlPlane: async () => true,
      timeoutMs: 10,
    });
    expect(filtered.state).toBe("udp_blocked");
    expect(filtered.remediation).toBe(HOTSPOT_REMEDIATION);
    // The remedy is a different network, never a different transport.
    expect(filtered.remediation).toMatch(/no WebRTC or WebSocket audio fallback/i);
    // Honest about the ambiguity rather than asserting the cause.
    expect(filtered.detail).toMatch(/a relay that is down looks the same/i);

    const offline = await probeRelayReachability({
      relayEndpoint: "https://draft-16.example.invalid",
      openWebTransport: refused,
      probeControlPlane: async () => false,
      timeoutMs: 10,
    });
    expect(offline.state).toBe("endpoint_unreachable");
    expect(offline.remediation).not.toBe(HOTSPOT_REMEDIATION);
  });

  it("treats a hanging handshake as a failure rather than waiting forever", async () => {
    const result = await probeRelayReachability({
      relayEndpoint: "https://draft-16.example.invalid",
      openWebTransport: () => ({ ready: new Promise<void>(() => {}), close: () => undefined }),
      probeControlPlane: async () => true,
      timeoutMs: 20,
    });
    expect(result.state).toBe("udp_blocked");
  });
});

describe("M1 — bounded session recovery", () => {
  it("draws delays across the whole backoff window, not just its top half", () => {
    // §11.2 asks for full jitter. Equal jitter would floor every draw at half
    // the window, which is what re-synchronises a room full of clients.
    const low = new ReconnectionPolicy(() => 0).next(0);
    const high = new ReconnectionPolicy(() => 0.999).next(0);
    expect(low.delayMs).toBeLessThan(high.delayMs / 2);
    // Floored, so an unlucky draw is not a tight retry loop.
    expect(low.delayMs).toBeGreaterThan(0);
  });

  it("grows the window exponentially and caps it", () => {
    const policy = new ReconnectionPolicy(() => 1);
    const delays = Array.from({ length: 8 }, () => policy.next(0).delayMs);
    expect(delays[0]).toBeLessThan(delays[1] as number);
    expect(Math.max(...delays)).toBeLessThanOrEqual(5_000);
  });

  it("becomes terminal after thirty seconds instead of retrying forever", () => {
    const policy = new ReconnectionPolicy(() => 0.5);
    expect(policy.next(0).retry).toBe(true);
    expect(policy.next(TERMINAL_AFTER_MS - 1).retry).toBe(true);
    const terminal = policy.next(TERMINAL_AFTER_MS);
    expect(terminal.retry).toBe(false);
    expect(terminal.delayMs).toBe(0);
  });

  it("resets after a successful restore or a presenter retry", () => {
    const policy = new ReconnectionPolicy(() => 0.5);
    policy.next(0);
    policy.next(TERMINAL_AFTER_MS + 1);
    policy.reset();
    expect(policy.next(0).retry).toBe(true);
    expect(policy.attempts).toBe(1);
  });
});
