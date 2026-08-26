import {
  FullTrackName,
  Publish,
  PublishOk,
  ReasonPhrase,
  RequestError,
  RequestErrorCode,
} from "moqtail";
import { describe, expect, it, vi } from "vitest";
import { ReconnectionPolicy, TERMINAL_AFTER_MS } from "../src/client/session/ReconnectionPolicy";
import {
  isRetryableTransportFailure,
  RoomSession,
  type SessionPhase,
  subscriptionRetryDelay,
} from "../src/client/session/RoomSession";
import { SessionEventLog } from "../src/client/session/SessionEventLog";
import {
  draftsFramedByClient,
  isTrackNotFoundError,
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
    let observedRequireUnreliable = false;
    let observedCongestionControl = "";
    Object.defineProperty(globalThis, "WebTransport", {
      value: class {
        readonly ready = Promise.reject(new Error("stop after constructor"));

        constructor(url: string | URL, options?: WebTransportOptions) {
          observedUrl = String(url);
          observedProtocols = [...(options?.protocols ?? [])];
          observedRequireUnreliable = options?.requireUnreliable ?? false;
          observedCongestionControl = options?.congestionControl ?? "";
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
      expect(observedRequireUnreliable).toBe(true);
      expect(observedCongestionControl).toBe("low-latency");
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

  it("waits for an explicit audio action before microphone or transport", async () => {
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

    expect(order).toEqual([]);
    let phase: SessionPhase = { name: "idle" };
    const unsubscribe = session.subscribe((state) => {
      phase = state.phase;
    });
    expect(phase).toEqual({ name: "awaiting_audio_start" });
    unsubscribe();
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
      .mockRejectedValueOnce(
        new MoqTransportError(
          "request_refused",
          "The relay refused the track subscription (code 16): Track not found",
          {
            operation: "track_subscription",
            errorCode: 16,
            reason: "Track not found",
          },
        ),
      )
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

  it("lets the listener unsubscribe and resubscribe to a remote human track", async () => {
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
    const closedStream = () =>
      new ReadableStream<{ groupId: number; objectId: number; payload: Uint8Array }>({
        start(controller) {
          controller.close();
        },
      });
    const subscribe = vi.fn().mockImplementation(async () => closedStream());
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const internal = session as unknown as {
      phase: SessionPhase;
      room: RoomSnapshot;
      transport: { subscribe: typeof subscribe; unsubscribe: typeof unsubscribe };
      reconcileSubscriptions: () => Promise<void>;
      snapshot: () => {
        subscribedParticipantIds: string[];
        subscriptions: Array<{ participantId: string; intent: boolean; status: string }>;
      };
    };
    internal.phase = { name: "live" };
    internal.room = {
      code: "AAAAAAAAAAAAAAAAAAAA",
      participants: [
        { id: "human-1", role: "human", state: "connected", simulated: false },
        { id: "human-2", role: "human", state: "connected", simulated: false },
      ],
      routing: [],
    } as unknown as RoomSnapshot;
    internal.transport.subscribe = subscribe;
    internal.transport.unsubscribe = unsubscribe;

    await internal.reconcileSubscriptions();
    expect(internal.snapshot().subscribedParticipantIds).toEqual(["human-2"]);
    expect(internal.snapshot().subscriptions[0]).toMatchObject({
      participantId: "human-2",
      intent: true,
      status: "subscribed",
    });

    await session.setSubscription("human-2", false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(internal.snapshot().subscribedParticipantIds).toEqual([]);
    expect(internal.snapshot().subscriptions[0]).toMatchObject({
      intent: false,
      status: "unsubscribed",
    });

    await session.setSubscription("human-2", true);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(internal.snapshot().subscribedParticipantIds).toEqual(["human-2"]);
    await session.close();
  });

  it("stops capture and withholds the publish event when the relay refuses PUBLISH", async () => {
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
    const internal = session as unknown as {
      phase: SessionPhase;
      publishing: boolean;
      captureMode: { name: string };
      capture: { stop: () => Promise<void> };
      handlePublicationFailure: (error: unknown) => Promise<void>;
      snapshot: () => {
        phase: SessionPhase;
        publishing: boolean;
        capture: { name: string; reason?: string };
        events: Array<{ kind: string; detail: string }>;
      };
    };
    internal.phase = { name: "live" };
    internal.publishing = false;
    internal.captureMode = { name: "opening_publication" };
    internal.capture.stop = vi.fn().mockResolvedValue(undefined);
    const refusal = new MoqTransportError(
      "request_refused",
      "The relay refused the track publication (code 16): namespace denied",
      { operation: "track_publication", errorCode: 16, reason: "namespace denied" },
    );

    await internal.handlePublicationFailure(refusal);

    expect(internal.capture.stop).toHaveBeenCalledTimes(1);
    expect(internal.snapshot()).toMatchObject({
      phase: { name: "blocked", failure: "relay_request_refused" },
      publishing: false,
      capture: { name: "listen_only", reason: refusal.message },
    });
    expect(internal.snapshot().events.some((event) => event.kind === "publish")).toBe(false);
    expect(internal.snapshot().events[0]?.detail).toBe(refusal.message);
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
    let releasePublish: (() => void) | undefined;
    const publishReady = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const calls = { addTrack: 0, publish: 0 };
    let registeredAlias: bigint | undefined;
    let publishedAlias: bigint | undefined;
    const client = {
      addOrUpdateTrack: (track: { trackAlias?: bigint }) => {
        calls.addTrack += 1;
        registeredAlias = track.trackAlias;
      },
      publish: async (_fullName: unknown, _forward: boolean, trackAlias: bigint) => {
        calls.publish += 1;
        publishedAlias = trackAlias;
        await publishReady;
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

    expect(calls).toEqual({ addTrack: 1, publish: 1 });
    expect(registeredAlias).toBe(1n);
    expect(publishedAlias).toBe(registeredAlias);
    releasePublish?.();
    await Promise.all([first, second]);

    expect(calls).toEqual({ addTrack: 1, publish: 1 });
    expect(adapter.sessionStats().publishedObjects).toBe(2);
  });

  it("preserves the exact PUBLISH refusal operation, code and reason", async () => {
    const client = {
      addOrUpdateTrack: vi.fn(),
      publish: vi
        .fn()
        .mockResolvedValue(
          new RequestError(
            1n,
            RequestErrorCode.DoesNotExist,
            0n,
            new ReasonPhrase("namespace denied"),
          ),
        ),
    };
    const adapter = new MoqTransportAdapter();
    const internal = adapter as unknown as {
      client: typeof client;
      stats: ReturnType<MoqTransportAdapter["sessionStats"]>;
    };
    internal.client = client;
    internal.stats = { ...adapter.sessionStats(), state: "connected" };

    await expect(
      adapter.publish(
        { namespace: "demo/room", name: "audio/participant" },
        { groupId: 1, objectId: 1, payload: new Uint8Array([1]) },
      ),
    ).rejects.toMatchObject({
      code: "request_refused",
      message: "The relay refused the track publication (code 16): namespace denied",
      request: {
        operation: "track_publication",
        errorCode: 16,
        reason: "namespace denied",
      },
    });
  });

  it("accepts a namespace-pushed publication and reuses its stream for subscribe", async () => {
    const onTrackPublished = vi.fn();
    const adapter = new MoqTransportAdapter({ onTrackPublished });
    const send = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn();
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const client = { controlStream: { send }, subscribe, unsubscribe };
    const internal = adapter as unknown as {
      client: typeof client;
      stats: ReturnType<MoqTransportAdapter["sessionStats"]>;
      handlePeerPublish: (message: Publish, stream: ReadableStream<never>) => Promise<void>;
    };
    internal.client = client;
    internal.stats = { ...adapter.sessionStats(), state: "connected" };
    const track = { namespace: "demo/room/participant", name: "audio/participant" };
    const message = new Publish(7n, FullTrackName.tryNew(track.namespace, track.name), 3n, []);
    const pushedStream = new ReadableStream<never>();

    await internal.handlePeerPublish(message, pushedStream);

    expect(send).toHaveBeenCalledWith(expect.any(PublishOk));
    expect(onTrackPublished).toHaveBeenCalledWith(track);
    const stream = await adapter.subscribe(track);
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(subscribe).not.toHaveBeenCalled();
    await stream.cancel();
    await adapter.unsubscribe(track);
    expect(unsubscribe).toHaveBeenCalledWith(7n);
  });

  it("defaults every other real room party to interested in pushed audio tracks", async () => {
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
    const internal = session as unknown as {
      room: RoomSnapshot;
      shouldAcceptPublishedTrack: (track: { namespace: string; name: string }) => boolean;
    };
    internal.room = {
      code: "AAAAAAAAAAAAAAAAAAAA",
      participants: [
        { id: "human-1", role: "human", state: "connected", simulated: false },
        { id: "human-2", role: "human", state: "connected", simulated: false },
        { id: "ai-1", role: "ai", state: "connected", simulated: false },
      ],
      routing: [],
    } as unknown as RoomSnapshot;

    expect(
      internal.shouldAcceptPublishedTrack({
        namespace: "demo/AAAAAAAAAAAAAAAAAAAA/human-2",
        name: "audio/human-2",
      }),
    ).toBe(true);
    expect(
      internal.shouldAcceptPublishedTrack({
        namespace: "demo/AAAAAAAAAAAAAAAAAAAA/ai-1",
        name: "audio/ai-1",
      }),
    ).toBe(true);
    expect(
      internal.shouldAcceptPublishedTrack({
        namespace: "demo/AAAAAAAAAAAAAAAAAAAA/human-1",
        name: "audio/human-1",
      }),
    ).toBe(false);
    await session.close();
  });

  it("sends UNINTERESTED only when the local track control opts out", async () => {
    const adapter = new MoqTransportAdapter({ shouldAcceptPublishedTrack: () => false });
    const send = vi.fn().mockResolvedValue(undefined);
    const client = { controlStream: { send } };
    const internal = adapter as unknown as {
      client: typeof client;
      stats: ReturnType<MoqTransportAdapter["sessionStats"]>;
      handlePeerPublish: (message: Publish, stream: ReadableStream<never>) => Promise<void>;
    };
    internal.client = client;
    internal.stats = { ...adapter.sessionStats(), state: "connected" };
    const message = new Publish(
      8n,
      FullTrackName.tryNew("demo/room/participant", "audio/participant"),
      4n,
      [],
    );

    await internal.handlePeerPublish(message, new ReadableStream<never>());

    const response = send.mock.calls[0]?.[0] as RequestError;
    expect(response).toBeInstanceOf(RequestError);
    expect(response.requestId).toBe(8n);
    expect(response.errorCode).toBe(RequestErrorCode.Uninterested);
  });

  it("classifies only code-16 Track not found subscriptions as publisher-not-ready", () => {
    expect(
      isTrackNotFoundError(
        new MoqTransportError("request_refused", "refused", {
          operation: "track_subscription",
          errorCode: 16,
          reason: "Track not found",
        }),
      ),
    ).toBe(true);
    expect(
      isTrackNotFoundError(
        new MoqTransportError("request_refused", "refused", {
          operation: "track_publication",
          errorCode: 16,
          reason: "Track not found",
        }),
      ),
    ).toBe(false);
  });

  it("backs off missing-track subscriptions and stops automatically", () => {
    expect(Array.from({ length: 6 }, (_, index) => subscriptionRetryDelay(index + 1))).toEqual([
      500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
    expect(subscriptionRetryDelay(7)).toBeNull();
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

  it("retains exact relay refusal evidence across a reload in the same browser session", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    };
    const detail = "The relay refused the track publication (code 16): namespace denied";
    new SessionEventLog("room-events", storage).record("failure", detail, { at: 1_000 });

    expect(new SessionEventLog("room-events", storage).list()[0]).toMatchObject({
      kind: "failure",
      detail,
      at: 1_000,
    });
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
