import { describe, expect, it } from "vitest";
import { ScriptedResponder } from "../src/client/ai/ScriptedResponder";
import { RoomSession } from "../src/client/session/RoomSession";
import type { RoomSnapshot } from "../src/shared/contracts";

describe("ScriptedResponder and RoomSession Context Tracking Benchmark", () => {
  it("measures ScriptedResponder.noteHeardUtterance over 1,000,000 audio object arrivals", () => {
    const scripted = new ScriptedResponder();
    const iterations = 1_000_000;
    const aiId = "ai-1";
    const humanId = "human-1";

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      scripted.noteHeardUtterance(aiId, humanId);
    }
    const end = performance.now();
    const duration = end - start;

    expect(scripted.utterancesHeard(aiId, humanId)).toBe(iterations);
    console.log(
      `[BENCHMARK] ScriptedResponder.noteHeardUtterance (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
  });

  it("measures RoomSession.noteScriptedContext over 1,000,000 frame arrivals across 17 AIs", () => {
    const now = Date.now();
    const session = new RoomSession({
      session: {
        code: "TEST1234",
        displayName: "Viewer",
        participantId: "viewer-1",
        rejoinToken: "token-1",
        storedAt: now,
      },
      presenterMode: false,
    });

    const humanId = "human-1";
    const roomSnapshot: RoomSnapshot = {
      code: "TEST1234",
      createdAt: now,
      expiresAt: now + 1_200_000,
      floor: { holderId: null, heldSince: null, queue: [] },
      aiToAi: { enabled: false, consecutiveTurns: 0, turnCap: 6, cappedAt: null },
      partialContextAiIds: [],
      presenter: { simulatedHumans: 0, simulatedAis: 17, scriptedResponses: true },
      composition: { humans: 1, ais: 17, valid: true },
      participants: [
        {
          id: humanId,
          displayName: "Human 1",
          role: "human",
          state: "connected",
          joinedAt: 1000,
          reconnectUntil: null,
          simulated: false,
          address: null,
          wakeName: null,
          pipeline: null,
          lastActiveAt: 1000,
        },
      ],
      routing: [],
      transport: {
        availability: "available",
        draft: "16",
        endpoint: "https://relay.test",
        endpointName: "test-relay",
        traceVerified: true,
        failure: null,
        reason: "Test relay",
        discovery: "subscribe_namespace",
        routingEnforcement: "cooperative",
      },
    };

    // Add 17 AIs and routing rows where AIs hear human-1
    for (let i = 1; i <= 17; i++) {
      const aiId = `ai-${i}`;
      roomSnapshot.participants.push({
        id: aiId,
        displayName: `AI ${i}`,
        role: "ai",
        state: "connected",
        joinedAt: 1000,
        reconnectUntil: null,
        simulated: true,
        address: `@ai_${i}`,
        wakeName: `AI ${i}`,
        pipeline: "listening",
        lastActiveAt: 1000,
      });
      roomSnapshot.routing.push({
        humanId,
        aiId,
        hearsMe: true,
        iHearIt: true,
        enforcement: "cooperative",
        updatedAt: now,
      });
    }

    // Apply room snapshot to populate listeningAisByHuman
    // @ts-expect-error accessing private method for benchmark
    session.applyRoom(roomSnapshot);

    const iterations = 1_000_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      // @ts-expect-error accessing private method for benchmark
      session.noteScriptedContext(humanId);
    }
    const end = performance.now();
    const duration = end - start;

    expect(session.scripted.utterancesHeard("ai-1", humanId)).toBe(iterations);
    console.log(
      `[BENCHMARK] RoomSession.noteScriptedContext (${iterations} ops, 17 AIs): ${duration.toFixed(2)} ms`,
    );
  });
});
