import { describe, expect, it, vi } from "vitest";
import { RoomSession } from "../src/client/session/RoomSession";
import type { Participant, RoomSnapshot, RoutingPreference } from "../src/shared/contracts";

const ROOM_CODE = "AAAAAAAAAAAAAAAAAAAA";

function participant(id: string, role: "human" | "ai"): Participant {
  return {
    id,
    displayName: id,
    role,
    state: "connected",
    joinedAt: 0,
    reconnectUntil: null,
    simulated: false,
    address: role === "ai" ? id : null,
    wakeName: role === "ai" ? id : null,
    pipeline: role === "ai" ? "listening" : null,
    lastActiveAt: 0,
  };
}

function routing(humanId: string, aiId: string, hearsMe: boolean): RoutingPreference {
  return {
    humanId,
    aiId,
    hearsMe,
    iHearIt: true,
    enforcement: "cooperative",
    updatedAt: 0,
  };
}

function room(participants: Participant[], rows: RoutingPreference[]): RoomSnapshot {
  const humans = participants.filter((entry) => entry.role === "human").length;
  const ais = participants.length - humans;
  return {
    code: ROOM_CODE,
    createdAt: 0,
    expiresAt: 60_000,
    participants,
    routing: rows,
    partialContextAiIds: [],
    transport: {
      availability: "available",
      draft: "16",
      endpoint: "https://relay.test",
      endpointName: "test relay",
      traceVerified: true,
      failure: null,
      reason: "",
      discovery: "subscribe_namespace",
      routingEnforcement: "cooperative",
    },
    aiToAi: { enabled: false, consecutiveTurns: 0, turnCap: 6, cappedAt: null },
    floor: { holderId: null, heldSince: null, queue: [] },
    presenter: { simulatedHumans: 0, simulatedAis: 0, scriptedResponses: false },
    composition: { humans, ais, valid: humans > 0 },
  };
}

describe("RoomSession scripted-context cache", () => {
  it("preserves routing semantics and rebuilds cached lookups for each snapshot", async () => {
    const session = new RoomSession({
      session: {
        code: ROOM_CODE,
        participantId: "human-1",
        rejoinToken: "token",
        displayName: "Human 1",
        storedAt: 0,
      },
      presenterMode: false,
    });
    const internal = session as unknown as {
      applyRoom(snapshot: RoomSnapshot): void;
      noteScriptedContext(participantId: string): void;
      scripted: { noteHeardUtterance(aiId: string, humanId: string): void };
    };
    const noteHeard = vi
      .spyOn(internal.scripted, "noteHeardUtterance")
      .mockImplementation(() => undefined);
    const human = participant("human-2", "human");
    const firstAi = participant("ai-1", "ai");
    const secondAi = participant("ai-2", "ai");

    internal.applyRoom(
      room(
        [human, firstAi, secondAi],
        [routing(human.id, firstAi.id, true), routing(human.id, secondAi.id, false)],
      ),
    );
    internal.noteScriptedContext(human.id);
    expect(noteHeard).toHaveBeenCalledOnce();
    expect(noteHeard).toHaveBeenCalledWith(firstAi.id, human.id);

    noteHeard.mockClear();
    internal.applyRoom(room([human, secondAi], [routing(human.id, secondAi.id, true)]));
    internal.noteScriptedContext(human.id);
    internal.noteScriptedContext("missing-human");

    expect(noteHeard).toHaveBeenCalledOnce();
    expect(noteHeard).toHaveBeenCalledWith(secondAi.id, human.id);
    await session.close();
  });
});
