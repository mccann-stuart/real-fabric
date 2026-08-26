import { describe, expect, it } from "vitest";
import { AiDirector } from "../src/client/ai/AiDirector";
import { ScriptedResponder } from "../src/client/ai/ScriptedResponder";
import { AdaptiveJitterBuffer } from "../src/client/audio/AdaptiveJitterBuffer";
import { DegradationLadder, describeStep } from "../src/client/audio/DegradationLadder";
import { DriftEstimator, MAXIMUM_CORRECTION_RATIO } from "../src/client/audio/DriftEstimator";
import { PlaybackDeduplicator } from "../src/client/audio/PlaybackDeduplicator";
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
  matchConfiguration,
  PINNED_CONFIGURATION,
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

  it("discards buffered and in-flight objects from the cancelled group", () => {
    const buffer = new AdaptiveJitterBuffer<string>();
    buffer.push({ sequence: 1, groupId: 7, receivedAt: 1_000, value: "a" });
    buffer.push({ sequence: 2, groupId: 7, receivedAt: 1_020, value: "b" });

    expect(buffer.cancelGroup(7)).toBe(2);
    expect(buffer.depth).toBe(0);

    // The object that was already on the wire when the group closed.
    buffer.push({ sequence: 3, groupId: 7, receivedAt: 1_040, value: "late" });
    expect(buffer.depth).toBe(0);
    expect(buffer.cancelledDrops).toBe(3);
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
    expect(aiDisplayActivity(agent, rows, "h1", ["h1", "h2"])).toBe("Not listening to you");
    // The other human sees only that the AI has an incomplete picture.
    expect(aiDisplayActivity(agent, rows, "h2", ["h1", "h2"])).toBe("Partial context");
  });

  it("reports the pipeline once the AI hears every human", () => {
    const rows = [
      routing({ humanId: "h1", hearsMe: true }),
      routing({ humanId: "h2", hearsMe: true }),
    ];
    expect(aiDisplayActivity(ai("a1", { pipeline: "thinking" }), rows, "h1", ["h1", "h2"])).toBe(
      "Thinking",
    );
    expect(aiDisplayActivity(ai("a1", { pipeline: "interrupted" }), rows, "h1", ["h1", "h2"])).toBe(
      "Interrupted",
    );
    expect(aiDisplayActivity(ai("a1", { pipeline: "unavailable" }), rows, "h1", ["h1", "h2"])).toBe(
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
});

describe("H12 — reload reclaims identity without duplicate playback", () => {
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
    for (let step = 1; step <= 200; step += 1) {
      // 500 ppm: the local clock runs slightly ahead of the sender's.
      gentle.observe(step * 20, step * 20 * 1.0005);
    }
    const ratio = gentle.correctionRatio();
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThanOrEqual(MAXIMUM_CORRECTION_RATIO);
    expect(gentle.health()).toBe("correcting");

    const severe = new DriftEstimator("t2");
    for (let step = 1; step <= 200; step += 1) severe.observe(step * 20, step * 20 * 1.08);
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
});

describe("FR5 — bounded reconnection with a terminal state", () => {
  it("backs off with jitter and gives up after 30 seconds", () => {
    const policy = new ReconnectionPolicy(() => 0.5);
    const first = policy.next(0);
    expect(first.retry).toBe(true);
    expect(first.delayMs).toBeGreaterThan(0);

    const second = policy.next(1_000);
    expect(second.delayMs).toBeGreaterThanOrEqual(first.delayMs);

    expect(policy.next(TERMINAL_AFTER_MS + 1).retry).toBe(false);
  });

  it("bounds the delay rather than backing off forever", () => {
    const policy = new ReconnectionPolicy(() => 1);
    let last = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) last = policy.next(attempt * 100).delayMs;
    expect(last).toBeLessThanOrEqual(5_000);
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
