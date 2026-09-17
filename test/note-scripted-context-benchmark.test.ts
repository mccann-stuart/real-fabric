import { describe, expect, it } from "vitest";
import { RoomSession } from "../src/client/session/RoomSession";
import type { Participant, RoomSnapshot } from "../src/shared/contracts";

describe("noteScriptedContext Benchmark with Precomputed Maps", () => {
  it("compares original noteScriptedContext vs precomputed maps", () => {
    const session = new RoomSession({
      session: {
        code: "BENCH_ROOM",
        participantId: "human-1",
        rejoinToken: "token",
        displayName: "Human 1",
        storedAt: Date.now(),
      },
      presenterMode: false,
    });

    const participants: Participant[] = [];
    for (let i = 1; i <= 25; i++) {
      participants.push({
        id: `human-${i}`,
        displayName: `Human ${i}`,
        role: "human",
        state: "connected",
        joinedAt: Date.now(),
        reconnectUntil: null,
        simulated: false,
        address: null,
        wakeName: null,
        pipeline: null,
        lastActiveAt: Date.now(),
      });
    }
    for (let i = 1; i <= 25; i++) {
      participants.push({
        id: `ai-${i}`,
        displayName: `AI ${i}`,
        role: "ai",
        state: "connected",
        joinedAt: Date.now(),
        reconnectUntil: null,
        simulated: false,
        address: `ai-${i}`,
        wakeName: `AI ${i}`,
        pipeline: "listening",
        lastActiveAt: Date.now(),
      });
    }

    const routing = [];
    for (let h = 1; h <= 25; h++) {
      for (let a = 1; a <= 25; a++) {
        routing.push({
          humanId: `human-${h}`,
          aiId: `ai-${a}`,
          hearsMe: true,
          iHearIt: true,
          enforcement: "enforced" as const,
          updatedAt: Date.now(),
        });
      }
    }

    const mockRoom: RoomSnapshot = {
      code: "BENCH_ROOM",
      createdAt: Date.now(),
      expiresAt: Date.now() + 10000,
      participants,
      routing,
      partialContextAiIds: [],
      transport: {
        availability: "available",
        draft: "16",
        endpoint: "https://relay.test",
        endpointName: "test-relay",
        traceVerified: true,
        failure: null,
        reason: "",
        discovery: "subscribe_namespace",
        routingEnforcement: "enforced",
      },
      aiToAi: { enabled: false, consecutiveTurns: 0, turnCap: 6, cappedAt: null },
      floor: { holderId: null, heldSince: null, queue: [] },
      presenter: { simulatedHumans: 0, simulatedAis: 0, scriptedResponses: false },
      composition: { humans: 25, ais: 25, valid: true },
    };

    // Original implementation
    const originalImplementation = (fromParticipantId: string) => {
      const room = mockRoom;
      if (!room) return;
      const sender = room.participants.find((participant) => participant.id === fromParticipantId);
      if (sender?.role !== "human") return;

      const hearsSenderByAi = new Map<string, boolean>();
      for (const row of room.routing) {
        if (row.humanId === fromParticipantId && !hearsSenderByAi.has(row.aiId)) {
          hearsSenderByAi.set(row.aiId, row.hearsMe);
        }
      }
      for (const participant of room.participants) {
        if (participant.role === "ai" && hearsSenderByAi.get(participant.id)) {
          (
            session as unknown as {
              scripted: { noteHeardUtterance: (a: string, h: string) => void };
            }
          ).scripted.noteHeardUtterance(participant.id, fromParticipantId);
        }
      }
    };

    // Precomputed implementation setup
    const participantsById = new Map<string, Participant>();
    const aiParticipants: Participant[] = [];
    for (const participant of mockRoom.participants) {
      participantsById.set(participant.id, participant);
      if (participant.role === "ai") {
        aiParticipants.push(participant);
      }
    }
    const hearsMeByHumanAndAi = new Map<string, Map<string, boolean>>();
    for (const row of mockRoom.routing) {
      let aiMap = hearsMeByHumanAndAi.get(row.humanId);
      if (!aiMap) {
        aiMap = new Map<string, boolean>();
        hearsMeByHumanAndAi.set(row.humanId, aiMap);
      }
      if (!aiMap.has(row.aiId)) {
        aiMap.set(row.aiId, row.hearsMe);
      }
    }

    const precomputedImplementation = (fromParticipantId: string) => {
      const sender = participantsById.get(fromParticipantId);
      if (sender?.role !== "human") return;

      const aiMap = hearsMeByHumanAndAi.get(fromParticipantId);
      if (!aiMap) return;

      for (let i = 0; i < aiParticipants.length; i++) {
        const ai = aiParticipants[i];
        if (ai && aiMap.get(ai.id)) {
          (
            session as unknown as {
              scripted: { noteHeardUtterance: (a: string, h: string) => void };
            }
          ).scripted.noteHeardUtterance(ai.id, fromParticipantId);
        }
      }
    };

    const iterations = 100_000;

    // Warmup
    for (let i = 0; i < 10_000; i++) {
      const id = `human-${(i % 25) + 1}`;
      originalImplementation(id);
      precomputedImplementation(id);
    }

    const startOriginal = performance.now();
    for (let i = 0; i < iterations; i++) {
      originalImplementation(`human-${(i % 25) + 1}`);
    }
    const elapsedOriginal = performance.now() - startOriginal;

    const startPrecomputed = performance.now();
    for (let i = 0; i < iterations; i++) {
      precomputedImplementation(`human-${(i % 25) + 1}`);
    }
    const elapsedPrecomputed = performance.now() - startPrecomputed;

    const speedupRatio = elapsedOriginal / elapsedPrecomputed;
    const speedupPct = ((elapsedOriginal - elapsedPrecomputed) / elapsedOriginal) * 100;

    console.log(
      `[BENCHMARK] Original (${iterations} ops): ${elapsedOriginal.toFixed(2)} ms (${((elapsedOriginal / iterations) * 1000).toFixed(3)} µs/op)`,
    );
    console.log(
      `[BENCHMARK] Precomputed (${iterations} ops): ${elapsedPrecomputed.toFixed(2)} ms (${((elapsedPrecomputed / iterations) * 1000).toFixed(3)} µs/op)`,
    );
    console.log(
      `[BENCHMARK] Speedup: ${speedupRatio.toFixed(2)}x (${speedupPct.toFixed(2)}% faster)`,
    );

    expect(elapsedPrecomputed).toBeLessThan(elapsedOriginal);
  }, 10_000);
});
