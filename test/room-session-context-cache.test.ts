import { describe, expect, it, vi } from "vitest";
import { projectObservedActivity } from "../src/client/room/participantLayout";
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

describe("SEC-13 — listener-observed activity", () => {
  it("orders from received audio while leaving unobserved participants at join time", () => {
    const first = { ...participant("human-1", "human"), joinedAt: 100, lastActiveAt: 10_000 };
    const second = { ...participant("human-2", "human"), joinedAt: 200, lastActiveAt: 20_000 };
    const shared = room([first, second], []);
    const projected = projectObservedActivity(
      shared,
      new Map([[second.id, { lastActiveAt: 500 }]]),
    );
    expect(projected.participants.map((entry) => entry.lastActiveAt)).toEqual([100, 500]);
    expect(shared.participants.map((entry) => entry.lastActiveAt)).toEqual([10_000, 20_000]);
  });

  it("preserves room reference when activity timestamps are unchanged", () => {
    const p1 = { ...participant("human-1", "human"), joinedAt: 100, lastActiveAt: 500 };
    const p2 = { ...participant("human-2", "human"), joinedAt: 200, lastActiveAt: 600 };
    const shared = room([p1, p2], []);
    const playersMap = new Map([
      ["human-1", { lastActiveAt: 500 }],
      ["human-2", { lastActiveAt: 600 }],
    ]);

    const firstProjection = projectObservedActivity(shared, playersMap);
    const secondProjection = projectObservedActivity(firstProjection, playersMap);

    expect(firstProjection).toBe(shared);
    expect(secondProjection).toBe(firstProjection);
  });

  it("copies changed activity while retaining untouched participant references", () => {
    const first = { ...participant("human-1", "human"), joinedAt: 100, lastActiveAt: 500 };
    const second = { ...participant("human-2", "human"), joinedAt: 200, lastActiveAt: 600 };
    const shared = room([first, second], []);
    const projected = projectObservedActivity(
      shared,
      new Map([
        [first.id, { lastActiveAt: 700 }],
        [second.id, { lastActiveAt: 600 }],
      ]),
    );
    expect(projected).not.toBe(shared);
    expect(projected.participants).not.toBe(shared.participants);
    expect(projected.participants[0]).toEqual({ ...first, lastActiveAt: 700 });
    expect(projected.participants[1]).toBe(second);
    expect(shared.participants[0]).toBe(first);
    expect(first.lastActiveAt).toBe(500);
  });
});
