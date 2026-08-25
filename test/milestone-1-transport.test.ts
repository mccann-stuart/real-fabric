import { describe, expect, it, vi } from "vitest";
import { ReconnectionPolicy, TERMINAL_AFTER_MS } from "../src/client/session/ReconnectionPolicy";
import {
  isRetryableTransportFailure,
  RoomSession,
  type SessionPhase,
} from "../src/client/session/RoomSession";
import { SessionEventLog } from "../src/client/session/SessionEventLog";
import {
  draftsFramedByClient,
  MoqTransportAdapter,
  MoqTransportError,
} from "../src/client/transport/MoqTransportAdapter";
import { HOTSPOT_REMEDIATION, probeRelayReachability } from "../src/client/transport/NetworkProbe";
import {
  asMoqDraft,
  MOQT_DRAFTS,
  PINNED_MOQT_DRAFT,
  type RoomSnapshot,
} from "../src/shared/contracts";
import { type Measurement, measured } from "../src/shared/measurement";
import { configuredRelayCredential } from "../src/worker/relayCredential";

/**
 * §11.2 milestone 1: live transport unblocking and relay interoperability.
 */

describe("M1 — draft registry and relay interoperability", () => {
  it("frames exactly the drafts the pinned client library implements", () => {
    // Read from the library, so bumping moqtail moves this rather than a
    // hand-maintained assertion drifting away from the wire encoder.
    expect(draftsFramedByClient()).toEqual(["16"]);
  });

  it("pins the milestone to a draft it can actually frame", () => {
    expect(draftsFramedByClient()).toContain(PINNED_MOQT_DRAFT);
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
    // provisioning a credential, and its recovery advice is different.
    expect("WebTransport" in globalThis).toBe(false);
    const adapter = new MoqTransportAdapter();
    await expect(
      adapter.connect("https://draft-16.example.invalid", "", PINNED_MOQT_DRAFT),
    ).rejects.toMatchObject({ code: "draft_unavailable" });
    expect(adapter.sessionStats().negotiation).toBeNull();
  });

  it("attempts no connection without a provisioned relay credential", async () => {
    // Past the capability gate, a missing credential still stops the attempt
    // rather than connecting anonymously and hoping the relay is open.
    Object.defineProperty(globalThis, "WebTransport", {
      value: class {},
      configurable: true,
    });
    try {
      const adapter = new MoqTransportAdapter();
      await expect(
        adapter.connect("https://draft-16.example.invalid", "", PINNED_MOQT_DRAFT),
      ).rejects.toMatchObject({ code: "relay_configuration" });
      expect(adapter.sessionStats().negotiation).toBeNull();
      expect(adapter.sessionStats().state).not.toBe("connected");
    } finally {
      Reflect.deleteProperty(globalThis, "WebTransport");
    }
  });

  it("offers the pinned WebTransport protocol once and carries the Cloudflare token in the path", async () => {
    let observedUrl = "";
    let observedProtocols: string[] = [];
    Object.defineProperty(globalThis, "WebTransport", {
      value: class {
        readonly ready = Promise.reject(new Error("stop after constructor"));

        constructor(url: string | URL, options?: WebTransportOptions) {
          observedUrl = String(url);
          observedProtocols = [...(options?.protocols ?? [])];
        }
      },
      configurable: true,
    });

    try {
      const adapter = new MoqTransportAdapter();
      const error = await adapter
        .connect("https://draft-16.example.invalid/relay", "provisioned token", PINNED_MOQT_DRAFT)
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );

      expect(observedProtocols).toEqual(["moqt-16"]);
      expect(new Set(observedProtocols).size).toBe(observedProtocols.length);
      expect(observedUrl).toBe("https://draft-16.example.invalid/relay/provisioned%20token");
      expect(error).toMatchObject({ code: "relay_unavailable" });
      expect((error as Error).message).not.toContain("provisioned token");
    } finally {
      Reflect.deleteProperty(globalThis, "WebTransport");
    }
  });

  it("treats deterministic transport failures as blocked rather than retryable", () => {
    expect(isRetryableTransportFailure("relay_failed")).toBe(true);
    expect(isRetryableTransportFailure("relay_auth_unavailable")).toBe(false);
    expect(isRetryableTransportFailure("relay_protocol_error")).toBe(false);
    expect(isRetryableTransportFailure("relay_request_refused")).toBe(false);
    expect(isRetryableTransportFailure("draft_mismatch")).toBe(false);
  });

  it("accepts only a non-empty configured Cloudflare relay token", () => {
    expect(configuredRelayCredential(undefined)).toBeNull();
    expect(configuredRelayCredential("   ")).toBeNull();
    expect(configuredRelayCredential(" provisioned-token ")).toBe("provisioned-token");
  });

  it("reports Not exposed for round-trip time rather than zero", () => {
    // H15: a browser that reports nothing must never read as a perfect link.
    expect(new MoqTransportAdapter().sessionStats().transportRttMs).toBe("Not exposed");
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
  it("reports observed object delivery and capacity measurements without inventing gates", () => {
    const session = new RoomSession({
      session: {
        code: "AAAAAAAAAAAAAAAAAAAA",
        participantId: "participant-1",
        rejoinToken: "rejoin-token",
        displayName: "Test participant",
        storedAt: 0,
      },
      presenterMode: false,
      now: () => 3_000,
    });
    const internal = session as unknown as {
      phase: SessionPhase;
      startedAt: number;
      transportReadyAt: number;
      publishing: boolean;
      players: Map<
        string,
        {
          participantId: string;
          released: boolean;
          objectStats: () => {
            objects: Measurement<number>;
            meanBytes: Measurement<number>;
            lateDrops: Measurement<number>;
            cancelledDrops: Measurement<number>;
            concealedFrames: Measurement<number>;
            comfortNoiseFrames: Measurement<number>;
            depthMs: Measurement<number>;
            skewPpm: Measurement<number>;
          };
        }
      >;
      transport: {
        sessionStats: () => {
          publishedObjects: number;
          subscribedObjects: number;
          transportRttMs: number;
        };
      };
      mixer: { outputLatencyMs: () => Measurement<number> };
      devices: {
        inputCount: () => Measurement<number>;
        deviceChanges: () => Measurement<number>;
      };
      metrics: () => import("../src/client/session/RoomSession").SessionMetrics;
    };
    internal.phase = { name: "live" };
    internal.startedAt = 0;
    internal.transportReadyAt = 1_000;
    internal.publishing = false;
    internal.players = new Map([
      [
        "participant-2",
        {
          participantId: "participant-2",
          released: false,
          objectStats: () => ({
            objects: measured(100),
            meanBytes: measured(102),
            lateDrops: measured(5),
            cancelledDrops: measured(2),
            concealedFrames: measured(3),
            comfortNoiseFrames: measured(1),
            depthMs: measured(80),
            skewPpm: measured(-400),
          }),
        },
      ],
    ]);
    internal.transport = {
      sessionStats: () => ({
        publishedObjects: 40,
        subscribedObjects: 100,
        transportRttMs: 30,
      }),
    };
    internal.mixer = { outputLatencyMs: () => measured(8) };
    internal.devices = {
      inputCount: () => measured(1),
      deviceChanges: () => measured(0),
    };

    const metrics = internal.metrics();
    expect(metrics.publishedObjects).toEqual(measured(40));
    expect(metrics.subscribedObjects).toEqual(measured(100));
    expect(metrics.objectsPerSecond).toEqual(measured(50));
    expect(metrics.meanObjectBytes).toEqual(measured(102));
    expect(metrics.lateDropRate).toEqual(measured(0.05));
    expect(metrics.worstBufferMs).toEqual(measured(80));
    expect(metrics.aggregateBufferMs).toEqual(measured(80));
    expect(metrics.worstDriftPpm).toEqual(measured(400));
    expect(metrics.activeDecoders).toEqual(measured(1));
  });

  it("starts microphone capture automatically while transport opens independently", async () => {
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
    const order: string[] = [];
    vi.spyOn(session, "startPublishing").mockImplementation(async () => {
      order.push("microphone");
    });
    const internal = session as unknown as {
      devices: { start: () => Promise<void> };
      openControlChannel: () => void;
      runNetworkProbe: (room: RoomSnapshot) => Promise<void>;
      openTransport: () => Promise<void>;
    };
    internal.devices.start = vi.fn().mockResolvedValue(undefined);
    internal.openControlChannel = vi.fn();
    internal.runNetworkProbe = vi.fn().mockResolvedValue(undefined);
    internal.openTransport = vi.fn().mockImplementation(async () => {
      order.push("transport");
    });

    await session.start({
      code: "AAAAAAAAAAAAAAAAAAAA",
      participants: [],
      aiToAi: { enabled: false },
    } as unknown as RoomSnapshot);

    expect(order).toEqual(["microphone", "transport"]);
    await session.close();
  });

  it("retries automatic human subscriptions when a late publication is announced", async () => {
    const session = new RoomSession({
      session: {
        code: "AAAAAAAAAAAAAAAAAAAA",
        participantId: "human-1",
        rejoinToken: "rejoin-token",
        displayName: "Human one",
        storedAt: 0,
      },
      presenterMode: false,
    });
    const stream = new ReadableStream<{
      groupId: number;
      objectId: number;
      payload: Uint8Array;
    }>({
      start(controller) {
        controller.close();
      },
    });
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(new MoqTransportError("request_refused", "Not published yet."))
      .mockResolvedValueOnce(stream);
    const internal = session as unknown as {
      phase: SessionPhase;
      room: RoomSnapshot;
      transport: {
        subscribe: typeof subscribe;
        callbacks: { onNamespacePublished?: () => void };
      };
      reconcileSubscriptions: () => Promise<void>;
      snapshot: () => { subscribedParticipantIds: string[] };
    };
    internal.phase = { name: "live" };
    internal.room = {
      code: "AAAAAAAAAAAAAAAAAAAA",
      participants: [
        { id: "human-1", role: "human", state: "connected", simulated: false },
        { id: "human-2", role: "human", state: "connected", simulated: false },
        { id: "simulated-human", role: "human", state: "connected", simulated: true },
      ],
      routing: [],
    } as unknown as RoomSnapshot;
    internal.transport.subscribe = subscribe;

    await internal.reconcileSubscriptions();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0]?.[0]).toMatchObject({
      namespace: "demo/AAAAAAAAAAAAAAAAAAAA/human-2",
      name: "audio/human-2",
    });
    expect(internal.snapshot().subscribedParticipantIds).toEqual([]);

    internal.transport.callbacks.onNamespacePublished?.();
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
    expect(internal.snapshot().subscribedParticipantIds).toEqual(["human-2"]);
    await session.close();
  });

  it("probes unknown namespace discovery and records the live result", async () => {
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
    const room = {
      code: "AAAAAAAAAAAAAAAAAAAA",
      transport: { discovery: "unknown" },
    } as RoomSnapshot;
    const internal = session as unknown as {
      room: RoomSnapshot;
      transport: { subscribeNamespace: (namespace: string) => Promise<void> };
      discover: (room: RoomSnapshot) => Promise<void>;
      snapshot: () => { room: RoomSnapshot | null; failures: string[] };
    };
    internal.room = room;
    internal.transport.subscribeNamespace = vi.fn().mockResolvedValue(undefined);

    await internal.discover(room);

    expect(internal.transport.subscribeNamespace).toHaveBeenCalledWith("demo/AAAAAAAAAAAAAAAAAAAA");
    expect(internal.snapshot().room?.transport.discovery).toBe("subscribe_namespace");
  });

  it("records control-channel discovery only after the live probe is refused", async () => {
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
    const room = {
      code: "AAAAAAAAAAAAAAAAAAAA",
      transport: { discovery: "unknown" },
    } as RoomSnapshot;
    const internal = session as unknown as {
      room: RoomSnapshot;
      transport: { subscribeNamespace: (namespace: string) => Promise<void> };
      discover: (room: RoomSnapshot) => Promise<void>;
      snapshot: () => { room: RoomSnapshot | null; failures: string[] };
    };
    internal.room = room;
    internal.transport.subscribeNamespace = vi
      .fn()
      .mockRejectedValue(new MoqTransportError("request_refused", "Not supported."));

    await internal.discover(room);

    expect(internal.snapshot().room?.transport.discovery).toBe("control_channel");
    expect(internal.snapshot().failures).toContain("namespace_discovery_unavailable");
  });

  it("moves a live room into bounded recovery when its MOQT session terminates", () => {
    vi.useFakeTimers();
    try {
      const session = new RoomSession({
        session: {
          code: "AAAAAAAAAAAAAAAAAAAA",
          participantId: "participant-1",
          rejoinToken: "rejoin-token",
          displayName: "Test participant",
          storedAt: 0,
        },
        presenterMode: false,
        now: () => 1_000,
      });
      const internal = session as unknown as {
        phase: SessionPhase;
        onTransportTerminated: (error: MoqTransportError) => void;
      };
      internal.phase = { name: "live" };

      let phase: SessionPhase = { name: "idle" };
      const unsubscribe = session.subscribe((state) => {
        phase = state.phase;
      });
      internal.onTransportTerminated(
        new MoqTransportError("relay_unavailable", "The established session ended."),
      );

      expect(phase).toMatchObject({ name: "reconnecting", attempt: 1 });
      unsubscribe();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not reset recovery after a handshake that terminates immediately", () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const session = new RoomSession({
        session: {
          code: "AAAAAAAAAAAAAAAAAAAA",
          participantId: "participant-1",
          rejoinToken: "rejoin-token",
          displayName: "Test participant",
          storedAt: 0,
        },
        presenterMode: false,
        now: () => now,
      });
      const internal = session as unknown as {
        phase: SessionPhase;
        transportReadyAt: number | null;
        onTransportTerminated: (error: MoqTransportError) => void;
      };

      internal.phase = { name: "live" };
      internal.transportReadyAt = now;
      internal.onTransportTerminated(new MoqTransportError("relay_unavailable", "ended"));
      now += 100;
      internal.phase = { name: "live" };
      internal.transportReadyAt = now;
      internal.onTransportTerminated(new MoqTransportError("relay_unavailable", "ended"));

      let phase: SessionPhase = { name: "idle" };
      const unsubscribe = session.subscribe((state) => {
        phase = state.phase;
      });
      expect(phase).toMatchObject({ name: "reconnecting", attempt: 2 });
      unsubscribe();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("opens one publication while concurrent audio frames wait", async () => {
    let releaseNamespace: (() => void) | undefined;
    const namespaceReady = new Promise<void>((resolve) => {
      releaseNamespace = resolve;
    });
    const calls = { addTrack: 0, publishNamespace: 0, publish: 0 };
    const client = {
      addOrUpdateTrack: () => {
        calls.addTrack += 1;
      },
      publishNamespace: async () => {
        calls.publishNamespace += 1;
        await namespaceReady;
        return {};
      },
      publish: async () => {
        calls.publish += 1;
        return { requestId: 0n, trackAlias: 1n };
      },
    };
    const adapter = new MoqTransportAdapter();
    const internal = adapter as unknown as {
      client: typeof client;
      stats: ReturnType<MoqTransportAdapter["sessionStats"]>;
    };
    internal.client = client;
    internal.stats = { ...adapter.sessionStats(), state: "connected" };
    const track = { namespace: "demo/room", name: "audio/participant" };
    const first = adapter.publish(track, { groupId: 1, objectId: 1, payload: new Uint8Array([1]) });
    const second = adapter.publish(track, {
      groupId: 1,
      objectId: 2,
      payload: new Uint8Array([2]),
    });

    expect(calls).toEqual({ addTrack: 1, publishNamespace: 1, publish: 0 });
    releaseNamespace?.();
    await Promise.all([first, second]);

    expect(calls).toEqual({ addTrack: 1, publishNamespace: 1, publish: 1 });
    expect(adapter.sessionStats().publishedObjects).toBe(2);
  });

  it("coalesces a frame-rate burst of the same transport failure", () => {
    const log = new SessionEventLog();
    log.record("failure", "The MOQT session is not connected.", { at: 1_000 });
    log.record("failure", "The MOQT session is not connected.", { at: 1_020 });
    log.record("failure", "The MOQT session is not connected.", { at: 1_040 });

    expect(log.list()).toHaveLength(1);

    log.record("failure", "The MOQT session is not connected.", { at: 2_000 });
    expect(log.list()).toHaveLength(2);
  });

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
