import { describe, expect, it } from "vitest";
import { AiDirector } from "../src/client/ai/AiDirector";
import { ScriptedResponder } from "../src/client/ai/ScriptedResponder";
import { AdaptiveJitterBuffer } from "../src/client/audio/AdaptiveJitterBuffer";
import {
  DegradationLadder,
  describeStep,
  UnderrunWindowCounter,
} from "../src/client/audio/DegradationLadder";
import { DriftEstimator, MAXIMUM_CORRECTION_RATIO } from "../src/client/audio/DriftEstimator";
import { encodeAudioObject } from "../src/client/audio/frame";
import { MixerGraph } from "../src/client/audio/MixerGraph";
import { PlaybackDeduplicator } from "../src/client/audio/PlaybackDeduplicator";
import { TrackPlayer } from "../src/client/audio/TrackPlayer";
import { prioritiseFailureCodes } from "../src/client/components/FailureBanner";
import { buildEdges } from "../src/client/components/SubscriptionGraph";
import { DEMO_STEPS, DemoRunner, evaluateStep } from "../src/client/presenter/DemoScript";
import { COMPACT_THRESHOLD, layoutParticipants } from "../src/client/room/participantLayout";
import {
  microphoneAction,
  punctuateReason,
  representedFailureCodes,
} from "../src/client/room/roomPresentation";
import { ReconnectionPolicy, TERMINAL_AFTER_MS } from "../src/client/session/ReconnectionPolicy";
import { RoomSession } from "../src/client/session/RoomSession";
import type { SessionEvent } from "../src/client/session/SessionEventLog";
import { SessionTelemetry } from "../src/client/telemetry/SessionTelemetry";
import {
  AI_TO_AI_TURN_CAP,
  aiDisplayActivity,
  BARGE_IN_BUDGET_MS,
  evaluateComposition,
  type Participant,
  type RoutingPreference,
} from "../src/shared/contracts";
import { ALL_FAILURE_CODES, allFailureStates, failureState } from "../src/shared/failures";
import { formatMeasurement, measured, notExposed } from "../src/shared/measurement";
import {
  currentUserAgentFacts,
  describePin,
  describeTargets,
  IOS_SAFARI_CONFIGURATION,
  MACOS_SAFARI_CONFIGURATION,
  matchConfiguration,
  PINNED_CONFIGURATION,
  type PinnedConfiguration,
} from "../src/shared/pinnedConfiguration";
import {
  audioTrack,
  fanOut,
  parseTrackName,
  participantNamespace,
  presenceTrack,
  roomNamespace,
  trackKey,
} from "../src/shared/tracks";

function human(id: string, overrides: Partial<Participant> = {}): Participant {
  return {
    id,
    displayName: id,
    role: "human",
    state: "connected",
    joinedAt: 0,
    reconnectUntil: null,
    simulated: false,
    address: null,
    wakeName: null,
    pipeline: null,
    lastActiveAt: 0,
    ...overrides,
  };
}

function ai(id: string, overrides: Partial<Participant> = {}): Participant {
  return {
    ...human(id),
    role: "ai",
    address: `ai/${id}`,
    wakeName: id,
    pipeline: "listening",
    ...overrides,
  };
}

function routing(overrides: Partial<RoutingPreference> = {}): RoutingPreference {
  return {
    humanId: "h1",
    aiId: "a1",
    hearsMe: false,
    iHearIt: true,
    enforcement: "cooperative",
    updatedAt: 0,
    ...overrides,
  };
}

/**
 * H1 source scan.
 *
 * `node:fs` does resolve under the Workers pool, but it is backed by workerd's
 * bundle filesystem rather than the checkout: `readdirSync("src/client/audio")`
 * fails with ENOENT on `/bundle/src/client/audio`, and the working directory
 * holds only the bundled entry point. Vite's raw glob is the equivalent that
 * works here — it inlines the actual bytes of every matched file at transform
 * time, so the assertions below read production source, not a description of
 * it. The glob pattern and options must stay literal for Vite to see them.
 */
function sourceFiles(modules: Record<string, unknown>): Array<[path: string, source: string]> {
  return Object.entries(modules)
    .map(([path, source]): [string, string] => [path.replace(/^\.\.\//, ""), String(source)])
    .sort(([left], [right]) => left.localeCompare(right));
}

/** The three directories that could plausibly carry audio. */
const AUDIO_PATH_SOURCES: Array<[path: string, source: string]> = [
  ...sourceFiles(
    import.meta.glob("../src/client/audio/**/*.ts", {
      query: "?raw",
      eager: true,
      import: "default",
    }),
  ),
  ...sourceFiles(
    import.meta.glob("../src/client/transport/**/*.ts", {
      query: "?raw",
      eager: true,
      import: "default",
    }),
  ),
  ...sourceFiles(
    import.meta.glob("../src/client/ai/**/*.ts", {
      query: "?raw",
      eager: true,
      import: "default",
    }),
  ),
];

const CLIENT_SOURCES = sourceFiles(
  import.meta.glob("../src/client/**/*.{ts,tsx}", {
    query: "?raw",
    eager: true,
    import: "default",
  }),
);

function clientSource(path: string): string {
  const found = CLIENT_SOURCES.find(([candidate]) => candidate === path);
  if (!found) throw new Error(`${path} was not inlined by the source scan`);
  return found[1];
}

/** The `{ … }` starting at `openIndex`, matched by depth. */
function balancedBlock(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  throw new Error("The block beginning at the given index is unbalanced.");
}

function occurrences(pattern: RegExp): string[] {
  return CLIENT_SOURCES.flatMap(([path, source]) =>
    [...source.matchAll(pattern)].map((match) => `${path}: ${match[0]}`),
  );
}

describe("H1 — no WebRTC or WebSocket audio fallback exists in the source", () => {
  /** Construction, plus any bare reference to a peer-connection constructor. */
  const FALLBACK_TRANSPORT = /\bnew\s+WebSocket\b|\b(?:webkit)?RTCPeerConnection\b/g;
  const SOCKET_CONSTRUCTION = /\bnew\s+WebSocket\s*\(/g;
  const PEER_CONNECTION = /\b(?:webkit)?RTCPeerConnection\b/g;

  it("reads production source rather than a description of it", () => {
    const paths = AUDIO_PATH_SOURCES.map(([path]) => path);
    expect(paths).toContain("src/client/audio/AdaptiveJitterBuffer.ts");
    expect(paths).toContain("src/client/audio/TrackPlayer.ts");
    expect(paths).toContain("src/client/transport/MoqTransportAdapter.ts");
    expect(paths).toContain("src/client/ai/AiDirector.ts");
    expect(paths.length).toBeGreaterThanOrEqual(16);
    expect(CLIENT_SOURCES.length).toBeGreaterThanOrEqual(paths.length);

    // Were the glob to stop inlining bodies, every assertion below would pass
    // vacuously over empty strings. Prove the bytes are really here.
    for (const [path, source] of AUDIO_PATH_SOURCES) {
      expect(source.length, path).toBeGreaterThan(0);
    }
    expect(clientSource("src/client/transport/MoqTransportAdapter.ts")).toContain("WebTransport");
    expect(clientSource("src/client/ai/AiDirector.ts")).toContain("class AiDirector");
  });

  it("constructs no peer connection and no socket anywhere on the audio path", () => {
    const offenders = AUDIO_PATH_SOURCES.flatMap(([path, source]) =>
      [...source.matchAll(FALLBACK_TRANSPORT)].map((match) => `${path}: ${match[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it("permits exactly one socket in the whole client, and no peer connection at all", () => {
    expect(occurrences(SOCKET_CONSTRUCTION)).toEqual([
      "src/client/session/RoomSession.ts: new WebSocket(",
    ]);
    expect(occurrences(PEER_CONNECTION)).toEqual([]);
  });

  it("allow-lists that one socket only because it is the control plane", () => {
    const roomSession = clientSource("src/client/session/RoomSession.ts");
    const declaration = roomSession.indexOf("private openControlChannel(): void {");
    expect(declaration).toBeGreaterThan(-1);
    const body = balancedBlock(roomSession, roomSession.indexOf("{", declaration));

    // The single socket lives inside openControlChannel, and its URL comes from
    // the room service's control-plane events endpoint.
    expect([...roomSession.matchAll(SOCKET_CONSTRUCTION)]).toHaveLength(1);
    expect(body).toContain("new WebSocket(roomEventsUrl(this.options.session))");
    expect(clientSource("src/client/api.ts")).toMatch(
      /function roomEventsUrl\([\s\S]{0,200}\/api\/rooms\/\$\{session\.code\}\/events/,
    );

    // Everything it sends is a JSON control message, and nothing it touches is
    // an audio primitive.
    const sends = [...body.matchAll(/\.send\(\s*([\s\S]{0,15})/g)].map(
      (match) => match[1]?.trimStart() ?? "",
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.startsWith("JSON.stringify(")).toBe(true);
    expect(body).toContain('type: "auth"');
    for (const audioToken of [
      "audioTrack",
      "encodeAudioObject",
      "Uint8Array",
      "ArrayBuffer",
      "Blob",
      "binaryType",
      "payload",
      "publish",
    ]) {
      expect(body.includes(audioToken), audioToken).toBe(false);
    }

    // Audio leaves by the MOQT adapter instead, on a different call entirely.
    expect(roomSession).toMatch(/this\.transport\s*\.publish\(\s*audioTrack\(/);
  });
});

describe("H2 — one independent track per participant, no mixing upstream", () => {
  it("addresses humans and AIs identically and opaquely", () => {
    expect(audioTrack("room1", "p1")).toEqual({
      namespace: "demo/room1/p1",
      name: "audio/p1",
    });
    expect(presenceTrack("room1", "p1")).toEqual({
      namespace: "demo/room1/p1",
      name: "presence/p1",
    });
    // §6.2: a human and an AI are indistinguishable at the relay, and neither
    // carries a display name.
    const asHuman = audioTrack("room1", "participant-1");
    const asAi = audioTrack("room1", "participant-2");
    expect(asHuman.name.replace("participant-1", "x")).toBe(
      asAi.name.replace("participant-2", "x"),
    );
    expect(`${asHuman.namespace} ${asHuman.name}`).not.toMatch(/\b(human|ai|bot|agent)\b/i);
    expect(parseTrackName("audio/p1")).toEqual({ kind: "audio", participantId: "p1" });
  });

  it("prefixes room identifiers with demo/ to form room namespace", () => {
    expect(roomNamespace("room1")).toBe("demo/room1");
    expect(roomNamespace("")).toBe("demo/");
    expect(roomNamespace("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "demo/550e8400-e29b-41d4-a716-446655440000",
    );
    expect(roomNamespace("stage/room-1")).toBe("demo/stage/room-1");
  });

  it("gives each publisher a distinct namespace under the room prefix", () => {
    expect(participantNamespace("room1", "p1")).toBe("demo/room1/p1");
    expect(audioTrack("room1", "p1").namespace).not.toBe(audioTrack("room1", "p2").namespace);
    expect(audioTrack("room1", "p1").namespace.startsWith("demo/room1/")).toBe(true);
  });

  it("combines namespace and name into a single track key string", () => {
    expect(trackKey({ namespace: "demo/room1/p1", name: "audio/p1" })).toBe(
      "demo/room1/p1/audio/p1",
    );
    expect(trackKey(audioTrack("room1", "p1"))).toBe("demo/room1/p1/audio/p1");
    expect(trackKey(presenceTrack("room1", "p1"))).toBe("demo/room1/p1/presence/p1");
    expect(trackKey({ namespace: "", name: "" })).toBe("/");
    expect(trackKey({ namespace: "ns", name: "" })).toBe("ns/");
    expect(trackKey({ namespace: "", name: "name" })).toBe("/name");
  });

  it("keeps the uplink at one track regardless of audience size", () => {
    expect(fanOut(["a", "b", "c"], true)).toEqual({ publishedTracks: 1, subscribedTracks: 3 });
    expect(fanOut(new Array(50).fill("x"), true).publishedTracks).toBe(1);
  });
});

describe("H3 — one pinned browser, others warned", () => {
  it("accepts the pinned configuration", () => {
    const match = matchConfiguration({
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/141.0.0.0 Safari/537.36",
      brands: [{ brand: "Google Chrome", version: "141" }],
      platform: "macOS",
    });
    expect(match.status).toBe("provisional");
    expect(match.liveAudioEligible).toBe(true);
  });

  it("rejects a different browser, an older version and another platform", () => {
    const edge = matchConfiguration({
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/141.0.0.0 Edg/141.0.0.0",
      platform: "macOS",
    });
    expect(edge.liveAudioEligible).toBe(false);

    const old = matchConfiguration({
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/120.0.0.0",
      platform: "macOS",
    });
    expect(old.liveAudioEligible).toBe(false);
    expect(old.reasons.join(" ")).toContain(String(PINNED_CONFIGURATION.minimumMajorVersion));

    const windows = matchConfiguration({
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0",
      platform: "Windows",
    });
    expect(windows.liveAudioEligible).toBe(false);
  });

  it("does not present a provisional pin as a decision", () => {
    expect(PINNED_CONFIGURATION.status).toBe("provisional");
    expect(PINNED_CONFIGURATION.note).toMatch(/Gate 2/);
  });

  describe("macOS Safari", () => {
    // Safari exposes no userAgentData, and freezes the Mac OS X token at 10_15_7.
    const MACOS_SAFARI_27 =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";

    it("admits top-level macOS Safari at the floor as provisional, not unsupported", () => {
      const match = matchConfiguration({ userAgent: MACOS_SAFARI_27, maxTouchPoints: 0 });
      expect(match).toMatchObject({
        status: "provisional",
        liveAudioEligible: true,
        browser: "Safari 27",
        browserMajorVersion: 27,
        platform: "macOS",
        device: "desktop",
        target: MACOS_SAFARI_CONFIGURATION,
      });
      expect(match.reasons.join(" ")).toMatch(/Gate 1|Gate 2/);
    });

    it("keeps macOS Safari below the floor unsupported and names the floor it missed", () => {
      const match = matchConfiguration({
        userAgent: MACOS_SAFARI_27.replace("Version/27.0", "Version/26.0"),
      });
      expect(match.status).toBe("unsupported");
      expect(match.liveAudioEligible).toBe(false);
      expect(match.reasons.join(" ")).toMatch(/macOS Safari floor is 27.*reports 26/i);
    });

    it("never mistakes a Chromium or Gecko browser for macOS Safari", () => {
      const impostors = [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/120.0.0.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Brave/141.0.0.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:130.0) Gecko/20100101 Firefox/130.0",
      ];
      for (const userAgent of impostors) {
        const match = matchConfiguration({ userAgent, maxTouchPoints: 0 });
        expect(match.liveAudioEligible).toBe(false);
        expect(match.target).not.toBe(MACOS_SAFARI_CONFIGURATION);
      }
    });

    it("does not admit a Chromium browser that reports brands but no Chrome token", () => {
      const match = matchConfiguration({
        userAgent: MACOS_SAFARI_27,
        brands: [{ brand: "Some Chromium Fork", version: "27" }],
      });
      expect(match.liveAudioEligible).toBe(false);
    });

    it("fails closed on iPadOS desktop mode, which reports the same Macintosh token", () => {
      const match = matchConfiguration({ userAgent: MACOS_SAFARI_27, maxTouchPoints: 5 });
      expect(match.status).toBe("readOnly");
      expect(match.liveAudioEligible).toBe(false);
      expect(match.device).toBe("iPad");
      expect(match.reasons.join(" ")).toMatch(/iPadOS/i);
    });
  });

  describe("describePin & describeTargets", () => {
    it("describes the pinned configuration using default argument", () => {
      expect(describePin()).toBe("Google Chrome 141+ on macOS");
    });

    it("describes the default desktop pinned configuration explicitly", () => {
      expect(describePin(PINNED_CONFIGURATION)).toBe("Google Chrome 141+ on macOS");
    });

    it("describes the iOS Safari configuration", () => {
      expect(describePin(IOS_SAFARI_CONFIGURATION)).toBe("Safari 27+ on iPhone iOS 27+");
    });

    it("handles custom configuration with platform major version floor", () => {
      const customPin: PinnedConfiguration = {
        browser: "Google Chrome",
        minimumMajorVersion: 140,
        platform: "macOS",
        minimumPlatformMajorVersion: 15,
        device: "desktop",
        status: "provisional",
        note: "Custom pin test.",
      };
      expect(describePin(customPin)).toBe("Google Chrome 140+ on macOS 15+");
    });

    it("handles custom iPhone configuration without platform major version floor", () => {
      const customIphonePin: PinnedConfiguration = {
        browser: "Safari",
        minimumMajorVersion: 26,
        platform: "iOS",
        device: "iPhone",
        status: "provisional",
        note: "Custom iPhone pin test.",
      };
      expect(describePin(customIphonePin)).toBe("Safari 26+ on iPhone iOS");
    });

    it("describes the macOS Safari configuration without an unreadable OS floor", () => {
      expect(describePin(MACOS_SAFARI_CONFIGURATION)).toBe("Safari 27+ on macOS");
      expect(MACOS_SAFARI_CONFIGURATION.minimumPlatformMajorVersion).toBeUndefined();
    });

    it("describes all configured targets", () => {
      expect(describeTargets()).toBe(
        "Google Chrome 141+ on macOS; Safari 27+ on macOS; Safari 27+ on iPhone iOS 27+; Google Chrome 141+ on iPhone iOS 27+",
      );
    });
  });

  it("extracts user agent facts from the global navigator object", () => {
    const originalNavigator = globalThis.navigator;

    try {
      // 1. Legacy browser without userAgentData
      Object.defineProperty(globalThis, "navigator", {
        value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
        configurable: true,
        writable: true,
      });
      expect(currentUserAgentFacts()).toEqual({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      });

      // 2. Modern browser with brands and platform in userAgentData
      const mockBrands = [{ brand: "Google Chrome", version: "141" }];
      Object.defineProperty(globalThis, "navigator", {
        value: {
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0",
          userAgentData: {
            brands: mockBrands,
            platform: "macOS",
          },
        },
        configurable: true,
        writable: true,
      });
      const facts = currentUserAgentFacts();
      expect(facts).toEqual({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0",
        brands: mockBrands,
        platform: "macOS",
      });
      expect(matchConfiguration(facts)).toMatchObject({
        status: "provisional",
        liveAudioEligible: true,
      });

      // 3. Modern browser with userAgentData having only brands
      Object.defineProperty(globalThis, "navigator", {
        value: {
          userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
          userAgentData: {
            brands: mockBrands,
          },
        },
        configurable: true,
        writable: true,
      });
      expect(currentUserAgentFacts()).toEqual({
        userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
        brands: mockBrands,
      });

      // 4. Modern browser with userAgentData having only platform
      Object.defineProperty(globalThis, "navigator", {
        value: {
          userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
          userAgentData: {
            platform: "macOS",
          },
        },
        configurable: true,
        writable: true,
      });
      expect(currentUserAgentFacts()).toEqual({
        userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
        platform: "macOS",
      });
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe("H5 and H10 — addressing, floor control and the AI-to-AI cap", () => {
  it("never starts a turn without an address", () => {
    const director = new AiDirector();
    director.register("a1");
    // There is no other entry point: ambient audio cannot reach a turn.
    expect(director.speaking).toBeNull();
    expect(director.address("a1", "h1").result).toBe("speaking");
  });

  it("serialises AI speech and queues the second AI", () => {
    const director = new AiDirector();
    director.register("a1");
    director.register("a2");
    expect(director.address("a1", "h1").result).toBe("speaking");
    const second = director.address("a2", "h1");
    expect(second.result).toBe("queued");
    expect(director.waiting).toEqual(["a2"]);

    const promoted = director.endTurn("a1");
    expect(promoted?.aiId).toBe("a2");
    expect(director.waiting).toEqual([]);
  });

  it("refuses AI-to-AI by default and caps it once enabled", () => {
    const director = new AiDirector();
    director.register("a1");
    expect(director.address("a1", "a2", "ai")).toEqual({
      result: "refused",
      reason: "ai_to_ai_disabled",
    });

    director.setAiToAi(true);
    for (let turn = 0; turn < AI_TO_AI_TURN_CAP; turn += 1) {
      expect(director.address("a1", "a2", "ai").result).toBe("speaking");
      director.endTurn("a1");
    }
    expect(director.address("a1", "a2", "ai")).toEqual({ result: "refused", reason: "turn_cap" });
    expect(director.aiToAi.consecutiveTurns).toBe(AI_TO_AI_TURN_CAP);
  });

  it("lets a human turn break the AI-to-AI chain", () => {
    const director = new AiDirector();
    director.register("a1");
    director.setAiToAi(true);
    director.address("a1", "a2", "ai");
    director.endTurn("a1");
    expect(director.aiToAi.consecutiveTurns).toBe(1);
    director.address("a1", "h1", "human");
    expect(director.aiToAi.consecutiveTurns).toBe(0);
  });

  it("suspends an AI while a subscribed human is reconnecting", () => {
    const director = new AiDirector();
    director.register("a1");
    director.suspendHuman("h1");
    expect(director.address("a1", "h1")).toEqual({ result: "refused", reason: "suspended" });
    director.resumeHuman("h1");
    expect(director.address("a1", "h1").result).toBe("speaking");
  });
});

describe("H6 — barge-in inside 300 ms, including objects in flight", () => {
  it("measures the stop latency against the budget", () => {
    let clock = 1_000;
    const director = new AiDirector({ now: () => clock });
    director.register("a1");
    director.address("a1", "h1");

    clock = 1_180;
    const result = director.bargeIn(1_000);
    expect(result).not.toBeNull();
    expect(result?.latencyMs).toBe(180);
    expect(result?.withinBudget).toBe(true);
    expect(director.speaking).toBeNull();
  });

  it("reports a missed budget rather than rounding it away", () => {
    let clock = 1_000;
    const director = new AiDirector({ now: () => clock });
    director.register("a1");
    director.address("a1", "h1");
    clock = 1_000 + BARGE_IN_BUDGET_MS + 40;
    expect(director.bargeIn(1_000)?.withinBudget).toBe(false);
  });

  it("discards buffered and in-flight objects from the group the director opened", () => {
    let clock = 1_000;
    const director = new AiDirector({ now: () => clock });
    director.register("a1");
    director.address("a1", "h1");
    const turn = director.speaking;
    if (!turn) throw new Error("Addressing the AI did not open a turn.");

    // A second, unrelated turn: its objects must survive the cancellation.
    const survivingGroup = turn.groupId + 1;
    const buffer = new AdaptiveJitterBuffer<string>();
    buffer.push({ sequence: 1, groupId: turn.groupId, receivedAt: 1_000, value: "a" });
    buffer.push({ sequence: 2, groupId: turn.groupId, receivedAt: 1_020, value: "b" });
    buffer.push({ sequence: 3, groupId: survivingGroup, receivedAt: 1_040, value: "other" });
    expect(buffer.depth).toBe(3);

    clock = 1_180;
    const stopped = director.bargeIn(1_000);
    if (!stopped) throw new Error("No AI was speaking when the human onset arrived.");
    // The group id is the director's, not a literal chosen by this test.
    expect(stopped.groupId).toBe(turn.groupId);

    expect(buffer.cancelGroup(stopped.groupId)).toBe(2);
    expect(buffer.depth).toBe(1);

    // The object that was already on the wire when the group closed.
    buffer.push({ sequence: 4, groupId: stopped.groupId, receivedAt: 1_060, value: "late" });
    expect(buffer.depth).toBe(1);
    expect(buffer.cancelledDrops).toBe(3);

    // The other turn is untouched and still playable.
    buffer.push({ sequence: 5, groupId: survivingGroup, receivedAt: 1_080, value: "other-late" });
    expect(buffer.depth).toBe(2);
    expect(buffer.pull(2_000)).toBe("other");
    expect(buffer.pull(2_000)).toBe("other-late");
  });

  it("cancels the speaking AI's group from the session's own human onset", async () => {
    const session = new RoomSession({
      session: {
        code: "ROOM",
        participantId: "h1",
        rejoinToken: "token",
        displayName: "Human 1",
        storedAt: 0,
      },
      presenterMode: false,
    });
    const internal = session as unknown as {
      players: Map<string, TrackPlayer>;
      log: { list(): SessionEvent[] };
      onHumanOnset(): Promise<void>;
    };

    const player = new TrackPlayer("ai-1", "audio/ai-1", new MixerGraph());
    internal.players.set("ai-1", player);
    const object = (sequence: number) =>
      encodeAudioObject(
        { participantHash: 1, mediaTimestamp: sequence * 20, sequence },
        new Uint8Array([1, 2, 3]),
      );

    session.director.register("ai-1");
    session.director.address("ai-1", "h1");
    const turn = session.director.speaking;
    if (!turn) throw new Error("Addressing the AI did not open a turn.");

    const survivingGroup = turn.groupId + 1;
    player.accept(turn.groupId, 1, object(1), 1_000);
    player.accept(turn.groupId, 2, object(2), 1_020);
    player.accept(survivingGroup, 3, object(3), 1_040);
    expect(player.buffer.depth).toBe(3);

    await internal.onHumanOnset();

    // Two queued objects from the AI's own group went; the other group stayed.
    expect(player.buffer.depth).toBe(1);
    expect(session.director.speaking).toBeNull();
    const bargeIn = internal.log.list().find((event) => event.kind === "barge_in");
    expect(bargeIn?.subject).toBe("ai-1");
    expect(bargeIn?.detail).toContain("2 queued objects discarded");

    // An object still on the wire from the cancelled group is refused too.
    player.accept(turn.groupId, 4, object(4), 1_060);
    expect(player.buffer.depth).toBe(1);
    // ...while the untouched group keeps accepting.
    player.accept(survivingGroup, 5, object(5), 1_080);
    expect(player.buffer.depth).toBe(2);
  });
});

describe("H7 — no cap, visible degradation", () => {
  it("climbs the ladder in order and announces every step", () => {
    const ladder = new DegradationLadder();
    const tracks = [
      { trackId: "t1", lastActiveAt: 0 },
      { trackId: "t2", lastActiveAt: 0 },
      { trackId: "t3", lastActiveAt: 0 },
    ];
    const strained = {
      activeSpeakers: 10,
      worstBufferMs: 190,
      underrunsInWindow: 9,
      tracks,
      now: 100_000,
    };

    const first = ladder.evaluate(strained);
    expect(first.step).toBe(1);
    expect(first.nominalBufferMs).toBeGreaterThan(60);
    expect(first.announcement).toBeTruthy();

    const second = ladder.evaluate(strained);
    expect(second.step).toBe(2);
    // Step two releases decoders for tracks silent beyond 30 seconds.
    expect(second.releasedDecoders).toEqual(["t1", "t2", "t3"]);

    const third = ladder.evaluate(strained);
    expect(third.step).toBe(3);
    expect(third.unsubscribed.length).toBeGreaterThan(0);
    // Synthetic protection thresholds must not masquerade as measured capacity.
    expect(third.announcement).toBe(
      `audio paused for ${third.unsubscribed.length} participants — capacity protection engaged`,
    );
    expect(describeStep(3, 1)).toBe("audio paused for 1 participant — capacity protection engaged");
  });

  it("unsubscribes the least recently active first", () => {
    const ladder = new DegradationLadder();
    const tracks = [
      { trackId: "recent", lastActiveAt: 99_000 },
      { trackId: "stale", lastActiveAt: 1_000 },
    ];
    const strained = {
      activeSpeakers: 12,
      worstBufferMs: 195,
      underrunsInWindow: 12,
      tracks,
      now: 100_000,
    };
    ladder.evaluate(strained);
    ladder.evaluate(strained);
    const third = ladder.evaluate(strained);
    expect(third.unsubscribed[0]).toBe("stale");
  });

  it("recovers when the load eases", () => {
    const ladder = new DegradationLadder();
    const tracks = [{ trackId: "t1", lastActiveAt: 99_000 }];
    ladder.evaluate({
      activeSpeakers: 10,
      worstBufferMs: 190,
      underrunsInWindow: 9,
      tracks,
      now: 100_000,
    });
    const calm = {
      activeSpeakers: 1,
      worstBufferMs: 60,
      underrunsInWindow: 0,
      tracks,
      now: 100_000,
    };
    ladder.evaluate(calm);
    ladder.evaluate(calm);
    expect(ladder.evaluate(calm).step).toBe(0);
  });

  it("says nothing at step zero and never invents a cap", () => {
    expect(describeStep(0, 0)).toBeNull();
  });

  it("counts only new underruns on active tracks", () => {
    const counter = new UnderrunWindowCounter();
    expect(counter.next([{ trackId: "remote", underruns: 50, active: true }])).toBe(0);
    expect(counter.next([{ trackId: "remote", underruns: 100, active: false }])).toBe(0);
    expect(counter.next([{ trackId: "remote", underruns: 100, active: true }])).toBe(0);
    expect(counter.next([{ trackId: "remote", underruns: 104, active: true }])).toBe(4);
  });

  it("does not repeat the one-remote eight-second pause loop after resubscription", () => {
    const counter = new UnderrunWindowCounter();
    const ladder = new DegradationLadder();
    const track = { trackId: "remote", lastActiveAt: 0 };
    let now = 0;
    let previousStep = 0;
    let pauseTransitions = 0;
    const evaluate = (underruns: number | null, active = true) => {
      now += 2_000;
      const snapshots = underruns === null ? [] : [{ trackId: track.trackId, underruns, active }];
      const state = ladder.evaluate({
        activeSpeakers: active && underruns !== null ? 1 : 0,
        worstBufferMs: 60,
        underrunsInWindow: counter.next(snapshots),
        tracks: underruns === null ? [] : [{ ...track, lastActiveAt: now }],
        now,
      });
      if (state.step === 3 && previousStep !== 3) pauseTransitions += 1;
      previousStep = state.step;
      return state;
    };

    // The first report is a baseline. Three genuinely strained windows then
    // reach the last-resort pause exactly once.
    expect(evaluate(100).step).toBe(0);
    expect(evaluate(104).step).toBe(1);
    expect(evaluate(108).step).toBe(2);
    expect(evaluate(112).step).toBe(3);

    // Three empty windows permit recovery and re-subscription. A fresh high
    // cumulative counter establishes a new baseline instead of replaying the
    // previous subscription's underruns into the ladder.
    evaluate(null);
    evaluate(null);
    expect(evaluate(null).step).toBe(2);
    expect(evaluate(500).step).toBe(2);
    for (let window = 0; window < 5; window += 1) evaluate(500);

    expect(previousStep).toBe(0);
    expect(pauseTransitions).toBe(1);
  });
});

describe("room status presentation", () => {
  it("offers exactly one state-derived microphone action", () => {
    expect(microphoneAction({ name: "idle" }, false)).toEqual({
      disabled: false,
      label: "Start microphone",
      visible: true,
    });
    expect(microphoneAction({ name: "idle" }, false, { name: "awaiting_audio_start" })).toEqual({
      disabled: false,
      label: "Start audio",
      visible: true,
    });
    expect(
      microphoneAction({ name: "resume_required", reason: "hidden" }, false, {
        name: "resume_required",
        reason: "hidden",
      }),
    ).toEqual({ disabled: false, label: "Resume audio", visible: true });
    expect(
      microphoneAction(
        { name: "listen_only", failure: "microphone_denied", reason: "Denied" },
        false,
        { name: "live" },
      ),
    ).toEqual({ disabled: false, label: "Try microphone again", visible: true });
    expect(
      microphoneAction({ name: "opening_publication" }, false, {
        name: "blocked",
        failure: "relay_auth_unavailable",
      }).visible,
    ).toBe(false);
    expect(
      microphoneAction(
        { name: "listen_only", failure: "relay_request_refused", reason: "Refused" },
        false,
        { name: "blocked", failure: "relay_request_refused" },
      ).label,
    ).toBe("Try microphone again");
    expect(microphoneAction({ name: "publishing" }, true).visible).toBe(false);
  });

  it("does not duplicate failures already represented in the status rail", () => {
    const represented = representedFailureCodes(
      { name: "listen_only", failure: "relay_request_refused", reason: "Refused" },
      true,
    );
    expect(represented).toEqual(["relay_request_refused", "beyond_measured_capacity"]);
    expect(
      prioritiseFailureCodes(
        ["audio_behind", "relay_request_refused", "participant_disconnected"],
        represented,
      ),
    ).toEqual(["audio_behind", "participant_disconnected"]);
  });

  it("orders the remaining failure rail by severity and punctuates technical reasons", () => {
    expect(
      prioritiseFailureCodes(["audio_behind", "participant_disconnected", "udp_blocked"]),
    ).toEqual(["udp_blocked", "audio_behind", "participant_disconnected"]);
    expect(punctuateReason("The relay refused publication")).toBe("The relay refused publication.");
    expect(punctuateReason("Already complete.")).toBe("Already complete.");
  });
});

describe("H8 — any composition with at least one human", () => {
  it("accepts one human alone, one human with several AIs, and humans with none", () => {
    expect(evaluateComposition([human("h1")])).toEqual({ humans: 1, ais: 0, valid: true });
    expect(
      evaluateComposition([
        human("h1"),
        ai("a1"),
        ai("a2"),
        ai("a3"),
        ai("a4"),
        ai("a5"),
        ai("a6"),
      ]),
    ).toEqual({ humans: 1, ais: 6, valid: true });
    expect(
      evaluateComposition(Array.from({ length: 12 }, (_, index) => human(`h${index}`))).valid,
    ).toBe(true);
  });

  it("rejects only a room with no human", () => {
    expect(evaluateComposition([ai("a1"), ai("a2")]).valid).toBe(false);
    expect(evaluateComposition([human("h1", { state: "left" })]).valid).toBe(false);
  });
});

describe("H9 — per-AI routing, honestly labelled", () => {
  it("shows the viewer their own state and everyone the partial-context badge", () => {
    const agent = ai("a1");
    const rows = [
      routing({ humanId: "h1", aiId: "a1", hearsMe: false }),
      routing({ humanId: "h2", aiId: "a1", hearsMe: true }),
    ];
    // The viewer whose consent is off sees that fact specifically.
    expect(aiDisplayActivity(agent, rows, "h1", true)).toBe("Not listening to you");
    // The other human sees only that the AI has an incomplete picture.
    expect(aiDisplayActivity(agent, rows, "h2", true)).toBe("Partial context");
  });

  it("reports the pipeline once the AI hears every human", () => {
    const rows = [
      routing({ humanId: "h1", hearsMe: true }),
      routing({ humanId: "h2", hearsMe: true }),
    ];
    expect(aiDisplayActivity(ai("a1", { pipeline: "thinking" }), rows, "h1", false)).toBe(
      "Thinking",
    );
    expect(aiDisplayActivity(ai("a1", { pipeline: "interrupted" }), rows, "h1", false)).toBe(
      "Interrupted",
    );
    expect(aiDisplayActivity(ai("a1", { pipeline: "unavailable" }), rows, "h1", false)).toBe(
      "Unavailable",
    );
  });

  it("makes an edge disappear when consent is withdrawn", () => {
    const participants = [human("h1"), ai("a1")];
    const withConsent = buildEdges(participants, [routing({ hearsMe: true })], "h1", true, ["a1"]);
    expect(withConsent.find((edge) => edge.kind === "ai_inbound")?.live).toBe(true);

    const withoutConsent = buildEdges(participants, [routing({ hearsMe: false })], "h1", true, [
      "a1",
    ]);
    expect(withoutConsent.find((edge) => edge.kind === "ai_inbound")?.live).toBe(false);
  });

  it("lets an AI answer only what it actually received", () => {
    const responder = new ScriptedResponder();
    expect(responder.respond({ aiId: "a1", askedBy: "h1", now: 0 }).canAnswer).toBe(false);

    responder.noteHeardUtterance("a1", "h1");
    expect(responder.respond({ aiId: "a1", askedBy: "h1", now: 0 }).canAnswer).toBe(true);

    // Withdrawing consent means it genuinely cannot answer afterwards.
    responder.resetHeard("a1", "h1");
    const refused = responder.respond({ aiId: "a1", askedBy: "h1", now: 0 });
    expect(refused.canAnswer).toBe(false);
    expect(refused.label).toMatch(/Scripted/);
  });

  it("applies state updates safely without deep nesting", () => {
    const responder = new ScriptedResponder();

    // Falsy or missing items state handled gracefully
    responder.applyState({});
    expect(responder.getItems()).toEqual([]);

    // Items without ID are skipped, new items are added, existing items are updated
    responder.applyState({
      items: [
        { name: "No ID item" } as unknown as { id: string },
        { id: "item1", val: 10 },
        { id: "item2", val: 20 },
      ],
    });

    expect(responder.getItems()).toEqual([
      { id: "item1", val: 10 },
      { id: "item2", val: 20 },
    ]);

    // Update existing item
    responder.applyState({
      items: [{ id: "item1", val: 15 }],
    });

    expect(responder.getItems()).toEqual([
      { id: "item1", val: 15 },
      { id: "item2", val: 20 },
    ]);

    // Clearing clears items
    responder.clear();
    expect(responder.getItems()).toEqual([]);
  });
});

/**
 * The "without duplicate playback" half of H12. The identity reclaim itself and
 * its 60-second window are proved where they are implemented: client-side in
 * `test/session-storage.test.ts` ("reclaims inside the 60-second window and
 * refuses one millisecond past it") and Worker-side in `test/room-service.test.ts`.
 * Naming this block after the reclaim would have claimed coverage it never had.
 */
describe("H12 — a reload replays nothing that already played", () => {
  it("refuses an object it has already played", () => {
    const dedupe = new PlaybackDeduplicator();
    expect(dedupe.accept("p1", 4, 9)).toBe(true);
    expect(dedupe.accept("p1", 4, 9)).toBe(false);
    // A different participant with the same identifiers is a different object.
    expect(dedupe.accept("p2", 4, 9)).toBe(true);
  });

  it("bounds its memory rather than growing for the whole session", () => {
    const dedupe = new PlaybackDeduplicator();
    for (let group = 0; group < 40; group += 1) dedupe.accept("p1", group, 1);
    expect(dedupe.retainedGroups("p1")).toBeLessThanOrEqual(4);
  });

  it("bounds objects per group to MAXIMUM_OBJECTS_PER_GROUP (100) (SEC-09)", () => {
    const dedupe = new PlaybackDeduplicator();
    for (let obj = 0; obj < 100; obj += 1) {
      expect(dedupe.accept("p1", 1, obj)).toBe(true);
    }
    // Any object past 100 in the same group is rejected to bound memory (CWE-770 / SEC-09)
    expect(dedupe.accept("p1", 1, 100)).toBe(false);
    expect(dedupe.accept("p1", 1, 101)).toBe(false);
  });

  it("keeps a resubscription from the played position out of the player", () => {
    // A reload resubscribes at a position the previous page already played.
    // The deduplicator has to be wired into the receive path for that to matter.
    const dedupe = new PlaybackDeduplicator();
    const object = (sequence: number) =>
      encodeAudioObject(
        { participantHash: 1, mediaTimestamp: sequence * 20, sequence },
        new Uint8Array([1, 2, 3]),
      );
    const player = () => new TrackPlayer("p1", "audio/p1", new MixerGraph(), {}, dedupe);

    const before = player();
    for (let sequence = 0; sequence < 5; sequence += 1) {
      before.accept(1, sequence, object(sequence), sequence * 20);
    }
    expect(before.buffer.depth).toBe(5);

    // The page reloads. The new player shares the session's deduplicator, and
    // the relay redelivers the retained group from its start.
    const after = player();
    for (let sequence = 0; sequence < 5; sequence += 1) {
      after.accept(1, sequence, object(sequence), 500 + sequence * 20);
    }
    expect(after.buffer.depth).toBe(0);

    // Only what genuinely follows the played position reaches the buffer.
    after.accept(1, 5, object(5), 620);
    expect(after.buffer.depth).toBe(1);
  });
});

describe("H13 — ten minutes without unbounded growth or uncorrected drift", () => {
  it("keeps the jitter buffer bounded across a long run", () => {
    const buffer = new AdaptiveJitterBuffer<number>();
    // 30,000 frames is ten minutes at 20 ms.
    for (let frame = 0; frame < 30_000; frame += 1) {
      buffer.push({
        sequence: frame,
        groupId: Math.floor(frame / 50),
        receivedAt: frame * 20,
        value: frame,
      });
      buffer.pull(frame * 20);
    }
    expect(buffer.depth).toBeLessThanOrEqual(Math.ceil(buffer.maximumMs / 20) + 1);
    expect(buffer.targetMs).toBeLessThanOrEqual(buffer.maximumMs);
    expect(buffer.targetMs).toBeGreaterThanOrEqual(buffer.minimumMs);
  });

  it("corrects slow drift and reports skew beyond the correction range", () => {
    const gentle = new DriftEstimator("t1");
    for (let step = 1; step <= 1_000; step += 1) {
      // 500 ppm: the local clock runs slightly ahead of the sender's.
      gentle.observe(step * 20, step * 20 * 1.0005);
    }
    const ratio = gentle.correctionRatio();
    expect(ratio).toBeLessThan(1);
    expect(ratio).toBeGreaterThanOrEqual(1 / MAXIMUM_CORRECTION_RATIO);
    expect(gentle.health()).toBe("correcting");

    const severe = new DriftEstimator("t2");
    for (let step = 1; step <= 1_000; step += 1) {
      severe.observe(step * 20, step * 20 * 1.08);
    }
    expect(severe.health()).toBe("beyond_range");
    expect(severe.correctionRatio()).toBeLessThanOrEqual(MAXIMUM_CORRECTION_RATIO);
  });

  it("does not report a drift estimate before it has converged", () => {
    const estimator = new DriftEstimator("t3");
    estimator.observe(0, 0);
    expect(estimator.skewPpm().exposed).toBe(false);
  });
});

describe("failureState", () => {
  it("returns the exact failure state matching the given code", () => {
    for (const code of ALL_FAILURE_CODES) {
      const state = failureState(code);
      expect(state.code).toBe(code);
      expect(typeof state.title).toBe("string");
      expect(state.title.length).toBeGreaterThan(0);
      expect(typeof state.experience).toBe("string");
      expect(state.experience.length).toBeGreaterThan(0);
      expect(typeof state.behaviour).toBe("string");
      expect(state.behaviour.length).toBeGreaterThan(0);
      expect(typeof state.recovery).toBe("string");
      expect(state.recovery.length).toBeGreaterThan(0);
      expect(["blocking", "degraded", "transient"]).toContain(state.severity);
      expect(typeof state.blocksPublication).toBe("boolean");
    }
  });
});

describe("H14 — every §10 failure has its own non-silent state", () => {
  it("covers every failure with distinct copy and its own recovery advice", () => {
    const states = allFailureStates();
    expect(states).toHaveLength(ALL_FAILURE_CODES.length);
    expect(states.length).toBeGreaterThanOrEqual(16);

    // What the viewer reads must differ per failure; two failures may share a
    // behaviour where the build genuinely does the same thing.
    const titles = new Set(states.map((state) => state.title));
    const experiences = new Set(states.map((state) => state.experience));
    expect(titles.size).toBe(states.length);
    expect(experiences.size).toBe(states.length);

    for (const state of states) {
      expect(state.recovery.length).toBeGreaterThan(0);
      expect(state.behaviour.length).toBeGreaterThan(0);
      expect(state.experience).not.toMatch(/something went wrong|unknown error/i);
    }
  });

  // These two assert the copy only. That the build has no such path is proved
  // by the H1 source scan above; a regex over failure strings cannot see it.
  it("never offers another transport as the recovery for a transport failure", () => {
    for (const state of allFailureStates()) {
      const copy = `${state.behaviour} ${state.recovery}`;
      expect(copy).not.toMatch(/(fall(s|ing)? back to|switch(ing)? to|use) (WebRTC|WebSocket)/i);
      expect(copy).not.toMatch(/downgrade the draft/i);
    }
  });

  it("states that no fallback transport exists", () => {
    const unsupported = allFailureStates().find((state) => state.code === "transport_unsupported");
    expect(unsupported?.behaviour).toMatch(/no WebRTC or WebSocket audio path/i);
  });
});

describe("H15 — unobservable measurements read Not exposed", () => {
  it("renders the label rather than a zero", () => {
    expect(formatMeasurement(notExposed<number>("no data"))).toBe("Not exposed");
    expect(formatMeasurement(measured(0))).toBe("0");
  });

  it("keeps exposure state through a telemetry export", () => {
    const telemetry = new SessionTelemetry();
    telemetry.recordMeasurement("transportRttMs", notExposed("not reported by this browser"));
    telemetry.recordMeasurement("reconnects", measured(0));
    const report = telemetry.report("ROOM") as {
      measurements: Record<string, unknown>;
    };
    expect(report.measurements.transportRttMs).toBe("Not exposed");
    expect(report.measurements.reconnects).toBe(0);
  });
});

describe("AC-14 — the sanitised export carries no identifying content", () => {
  it("strips forbidden fields even when a caller passes them", () => {
    const telemetry = new SessionTelemetry();
    telemetry.record({
      type: "routing_change",
      participantId: "opaque-id",
      ...({ displayName: "Ada Lovelace", token: "secret", transcript: "hello" } as object),
    });
    const serialised = JSON.stringify(telemetry.report("ROOM"));
    expect(serialised).toContain("opaque-id");
    expect(serialised).not.toContain("Ada Lovelace");
    expect(serialised).not.toContain("secret");
    expect(serialised).not.toContain("hello");
  });

  it("strips identifying content nested inside an unlisted key", () => {
    const telemetry = new SessionTelemetry();
    telemetry.record({
      type: "routing_change",
      participantId: "opaque-id",
      // A deny-list over top-level keys lets this through untouched.
      ...({
        meta: { transcript: "hello there", deviceLabel: "MacBook Pro Microphone" },
      } as object),
    });

    const serialised = JSON.stringify(telemetry.report("ROOM"));
    expect(serialised).toContain("opaque-id");
    expect(serialised).not.toContain("hello there");
    expect(serialised).not.toContain("MacBook Pro Microphone");
    expect(serialised).not.toContain("meta");
  });

  it("carries protocol values but refuses free text smuggled through value", () => {
    const telemetry = new SessionTelemetry();
    telemetry.record({ type: "degradation_step", value: 2 });
    telemetry.record({ type: "failure", value: "relay_request_refused" });
    telemetry.record({ type: "routing_change", value: "Ada Lovelace" });

    const report = telemetry.report("ROOM") as { events: Array<Record<string, unknown>> };
    expect(report.events.map((event) => event.value)).toEqual([
      2,
      "relay_request_refused",
      undefined,
    ]);
    expect(JSON.stringify(report)).not.toContain("Ada Lovelace");
  });

  it("filters again on export, so a retained event cannot leave unsanitised", () => {
    const telemetry = new SessionTelemetry();
    telemetry.record({ type: "routing_change", participantId: "opaque-id" });

    // Reach past record() the way a future caller or a direct push would.
    const retained = (telemetry as unknown as { events: Array<Record<string, unknown>> }).events;
    retained[0] = { ...retained[0], displayName: "Ada Lovelace" };

    const serialised = JSON.stringify(telemetry.report("ROOM"));
    expect(serialised).toContain("opaque-id");
    expect(serialised).not.toContain("Ada Lovelace");
  });
});

describe("FR5 — bounded reconnection with a terminal state", () => {
  /** With `random` stubbed the whole series is deterministic, so assert it. */
  function series(random: () => number, attempts = 6): number[] {
    const policy = new ReconnectionPolicy(random);
    return Array.from({ length: attempts }, () => policy.next(0).delayMs);
  }

  it("draws from the whole backoff window, doubling to a 5 s ceiling", () => {
    // §11.2 full jitter: the delay is `exponential × random()`. At the top of
    // the window the draw contributes its full share, which is also the plain
    // exponential schedule: 400 ms doubling until the 5 s bound.
    expect(series(() => 1)).toEqual([400, 800, 1_600, 3_200, 5_000, 5_000]);
  });

  it("scales the delay by the draw rather than jittering only the top half", () => {
    // Half the window is half of each step, all the way up — a narrower band
    // (say `exponential/2 + exponential/2 × random()`) could not produce this,
    // and removing jitter entirely would repeat the full-window series above.
    expect(series(() => 0.5)).toEqual([200, 400, 800, 1_600, 2_500, 2_500]);
    expect(series(() => 0.25)).toEqual([100, 200, 400, 800, 1_250, 1_250]);
  });

  it("floors an unlucky draw at 50 ms instead of a tight retry loop", () => {
    // The bottom of a full-jitter window is zero. MINIMUM_DELAY_MS lifts it.
    expect(series(() => 0)).toEqual([50, 50, 50, 50, 50, 50]);
    // The floor applies to the delay, not to the schedule: attempts still climb.
    const policy = new ReconnectionPolicy(() => 0);
    expect([policy.next(0).attempt, policy.next(0).attempt]).toEqual([1, 2]);
  });

  it("returns the exact terminal decision once the 30-second window closes", () => {
    const policy = new ReconnectionPolicy(() => 1);
    expect(policy.next(0)).toEqual({ retry: true, attempt: 1, delayMs: 400, elapsedMs: 0 });
    expect(policy.next(10_000)).toEqual({
      retry: true,
      attempt: 2,
      delayMs: 800,
      elapsedMs: 10_000,
    });

    // The deadline is inclusive, and terminal costs no further attempt.
    expect(policy.next(TERMINAL_AFTER_MS)).toEqual({
      retry: false,
      attempt: 2,
      delayMs: 0,
      elapsedMs: TERMINAL_AFTER_MS,
    });
    expect(policy.next(TERMINAL_AFTER_MS + 5_000)).toEqual({
      retry: false,
      attempt: 2,
      delayMs: 0,
      elapsedMs: TERMINAL_AFTER_MS + 5_000,
    });
    expect(policy.attempts).toBe(2);

    // The presenter's manual retry re-opens the window from scratch.
    policy.reset();
    expect(policy.next(TERMINAL_AFTER_MS)).toEqual({
      retry: true,
      attempt: 1,
      delayMs: 400,
      elapsedMs: 0,
    });
  });
});

describe("§4.2 — the grid scales without churning", () => {
  it("uses equal cards below the threshold", () => {
    const participants = Array.from({ length: COMPACT_THRESHOLD - 1 }, (_, index) =>
      human(`h${index}`),
    );
    const result = layoutParticipants(participants, "h0");
    expect(result.layout).toBe("equal");
    expect(result.rest).toHaveLength(0);
  });

  it("holds the viewer and recent speakers prominent above the threshold", () => {
    const participants = Array.from({ length: 12 }, (_, index) =>
      human(`h${index}`, { lastActiveAt: index }),
    );
    const result = layoutParticipants(participants, "h0");
    expect(result.layout).toBe("compact");
    expect(result.prominent[0]?.id).toBe("h0");
    expect(result.prominent).toHaveLength(4);
    // Nobody is hidden behind a menu.
    expect(result.prominent.length + result.rest.length).toBe(12);
  });

  it("keeps a previously prominent speaker in place", () => {
    const participants = Array.from({ length: 12 }, (_, index) =>
      human(`h${index}`, { lastActiveAt: index }),
    );
    const result = layoutParticipants(participants, "h0", ["h3"]);
    expect(result.prominent.map((participant) => participant.id)).toContain("h3");
  });
});

describe("H16 — the §12 script, twice clean", () => {
  it("encodes every cue in the specification order", () => {
    expect(DEMO_STEPS).toHaveLength(12);
    const times = DEMO_STEPS.map((step) => step.atSeconds);
    expect([...times].sort((left, right) => left - right)).toEqual(times);
  });

  it("fails the fan-out cue when the uplink is not one track", () => {
    const context = {
      msSinceRoomOpen: 1_000,
      participantCount: 4,
      aisSpeaking: 0,
      publishedTracks: measured(2),
      subscribedTracks: measured(3),
      lastBargeInMs: notExposed<number>("none"),
      lastRoutingChangeMs: notExposed<number>("none"),
      partialContextAiIds: [],
      floorQueueLength: 0,
      duplicatePlaybackDetected: false,
      identityReclaimed: true,
      unobservablesLabelled: true,
    };
    expect(evaluateStep("fan_out", context).outcome).toBe("failed");
    expect(evaluateStep("fan_out", { ...context, publishedTracks: measured(1) }).outcome).toBe(
      "passed",
    );
  });

  it("fails the human-exchange cue if any AI speaks unaddressed", () => {
    const base = {
      msSinceRoomOpen: 1_000,
      participantCount: 4,
      aisSpeaking: 1,
      publishedTracks: measured(1),
      subscribedTracks: measured(3),
      lastBargeInMs: notExposed<number>("none"),
      lastRoutingChangeMs: notExposed<number>("none"),
      partialContextAiIds: [],
      floorQueueLength: 0,
      duplicatePlaybackDetected: false,
      identityReclaimed: true,
      unobservablesLabelled: true,
    };
    expect(evaluateStep("human_exchange", base).outcome).toBe("failed");
    expect(evaluateStep("human_exchange", { ...base, aisSpeaking: 0 }).outcome).toBe("passed");
  });

  it("fails the reload cue on duplicate playback", () => {
    const base = {
      msSinceRoomOpen: 1_000,
      participantCount: 2,
      aisSpeaking: 0,
      publishedTracks: measured(1),
      subscribedTracks: measured(1),
      lastBargeInMs: notExposed<number>("none"),
      lastRoutingChangeMs: notExposed<number>("none"),
      partialContextAiIds: [],
      floorQueueLength: 0,
      duplicatePlaybackDetected: true,
      identityReclaimed: true,
      unobservablesLabelled: true,
    };
    expect(evaluateStep("reload", base).outcome).toBe("failed");
    expect(evaluateStep("reload", { ...base, duplicatePlaybackDetected: false }).outcome).toBe(
      "passed",
    );
  });

  it("requires two clean runs and does not count a skipped cue as a pass", () => {
    let clock = 0;
    const runner = new DemoRunner(() => ++clock);
    const clean = {
      msSinceRoomOpen: 1_000,
      participantCount: 2,
      aisSpeaking: 0,
      publishedTracks: measured(1),
      subscribedTracks: measured(1),
      lastBargeInMs: measured(120),
      lastRoutingChangeMs: measured(200),
      partialContextAiIds: ["a1"],
      floorQueueLength: 0,
      duplicatePlaybackDetected: false,
      identityReclaimed: true,
      unobservablesLabelled: true,
    };

    for (let run = 0; run < 2; run += 1) {
      runner.begin();
      for (let step = 0; step < DEMO_STEPS.length; step += 1) runner.record(clean, "passed");
    }
    expect(runner.cleanRuns).toBe(2);
    expect(runner.releaseGateMet).toBe(true);

    const skipping = new DemoRunner(() => ++clock);
    skipping.begin();
    for (let step = 0; step < DEMO_STEPS.length; step += 1) skipping.record(clean, "skipped");
    expect(skipping.cleanRuns).toBe(0);
    expect(skipping.releaseGateMet).toBe(false);
  });

  it("marks an abandoned run as failed rather than incomplete", () => {
    let clock = 0;
    const runner = new DemoRunner(() => ++clock);
    runner.begin();
    runner.abandon("network dropped");
    expect(runner.history[0]?.clean).toBe(false);
    expect(runner.history[0]?.results.every((result) => result.outcome !== "pending")).toBe(true);
  });
});
