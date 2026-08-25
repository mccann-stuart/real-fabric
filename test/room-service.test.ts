import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AI_TO_AI_TURN_CAP,
  type CreateRoomResponse,
  MAX_SIMULATED_PARTICIPANTS,
  type RoomSnapshot,
} from "../src/shared/contracts";

const BASE = "https://real-fabric.test";
let addressCounter = 0;

async function createRoom(displayName = "Ada"): Promise<CreateRoomResponse> {
  // A distinct address per room keeps the creation rate limit out of the way.
  addressCounter += 1;
  const response = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `192.0.2.${addressCounter % 250}`,
    },
    body: JSON.stringify({ displayName }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as CreateRoomResponse;
}

async function call<T>(
  path: string,
  body: unknown,
  method = "POST",
): Promise<{ status: number; value: T }> {
  const response = await SELF.fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  return { status: response.status, value };
}

function credential(created: CreateRoomResponse) {
  return { participantId: created.participant.id, rejoinToken: created.rejoinToken };
}

async function addAi(created: CreateRoomResponse, displayName: string): Promise<RoomSnapshot> {
  const { status, value } = await call<RoomSnapshot>(`/api/rooms/${created.room.code}/ai`, {
    ...credential(created),
    displayName,
    address: `ai/${displayName.toLowerCase()}`,
    wakeName: displayName,
    simulated: true,
  });
  expect(status).toBe(201);
  return value;
}

describe("H1 — transport is never claimed before it is traced", () => {
  it("reports draft 20 unavailable without downgrading", async () => {
    const created = await createRoom();
    expect(created.room.transport.availability).toBe("draft_unavailable");
    expect(created.room.transport.failure).toBe("draft_endpoint_missing");
    expect(created.room.transport.draft).toBe("20");
    expect(created.room.transport.endpointName).toBe("no configured endpoint");
    expect(created.room.transport.traceVerified).toBe(false);
    expect(created.room.transport.reason).toMatch(/no relay endpoint.*draft 20/i);
  });

  it("returns no relay credential while no draft-20 endpoint is configured", async () => {
    const created = await createRoom();
    expect(created.relayCredential).toBeNull();
  });

  it("states which discovery mechanism and routing enforcement are in effect", async () => {
    const created = await createRoom();
    expect(created.room.transport.discovery).toBe("unknown");
    expect(created.room.transport.routingEnforcement).toBe("cooperative");
  });
});

describe("H5 and H8 — AI identity and valid compositions", () => {
  it("gives each AI its own address and starts it listening", async () => {
    const created = await createRoom();
    const room = await addAi(created, "Atlas");
    const agent = room.participants.find((participant) => participant.role === "ai");
    expect(agent?.address).toBe("ai/atlas");
    expect(agent?.wakeName).toBe("Atlas");
    expect(agent?.pipeline).toBe("listening");
  });

  it("accepts one human with several AIs", async () => {
    const created = await createRoom();
    let room = created.room;
    for (const name of ["Atlas", "Sage", "Pilot", "Ember", "Quill", "Nomad"]) {
      room = await addAi(created, name);
    }
    expect(room.composition).toEqual({ humans: 1, ais: 6, valid: true });
  });

  it("accepts several humans with no AI", async () => {
    const created = await createRoom();
    for (const name of ["Grace", "Linus", "Radia"]) {
      const { status } = await call<CreateRoomResponse>(`/api/rooms/${created.room.code}/join`, {
        displayName: name,
      });
      expect(status).toBe(200);
    }
    const response = await SELF.fetch(`${BASE}/api/rooms/${created.room.code}`);
    const room = (await response.json()) as RoomSnapshot;
    expect(room.composition).toEqual({ humans: 4, ais: 0, valid: true });
  });
});

describe("H7 — membership is open", () => {
  it("never refuses a join for participant count", async () => {
    const created = await createRoom();
    for (let index = 0; index < 24; index += 1) {
      const { status } = await call<CreateRoomResponse>(`/api/rooms/${created.room.code}/join`, {
        displayName: `Guest ${index}`,
      });
      expect(status).toBe(200);
    }
    const response = await SELF.fetch(`${BASE}/api/rooms/${created.room.code}`);
    const room = (await response.json()) as RoomSnapshot;
    expect(room.participants).toHaveLength(25);
  });
});

describe("H9 and §8 — consent is per human and AI pair", () => {
  it("withholds inbound consent until the human acts", async () => {
    const created = await createRoom();
    const room = await addAi(created, "Atlas");
    const agent = room.participants.find((participant) => participant.role === "ai");
    const row = room.routing.find((entry) => entry.aiId === agent?.id);
    expect(row?.hearsMe).toBe(false);
    // Outbound is purely local and affects nobody else, so it starts on.
    expect(row?.iHearIt).toBe(true);
    expect(row?.enforcement).toBe("cooperative");
  });

  it("does not let a new AI inherit consent from an AI already present", async () => {
    const created = await createRoom();
    const first = await addAi(created, "Atlas");
    const atlas = first.participants.find((participant) => participant.role === "ai");

    const granted = await call<RoomSnapshot>(`/api/rooms/${created.room.code}/routing`, {
      ...credential(created),
      aiId: atlas?.id,
      hearsMe: true,
      iHearIt: true,
    });
    expect(granted.value.routing.find((row) => row.aiId === atlas?.id)?.hearsMe).toBe(true);

    const second = await addAi(created, "Sage");
    const sage = second.participants.find(
      (participant) => participant.role === "ai" && participant.id !== atlas?.id,
    );
    expect(second.routing.find((row) => row.aiId === sage?.id)?.hearsMe).toBe(false);
    // The earlier grant is untouched.
    expect(second.routing.find((row) => row.aiId === atlas?.id)?.hearsMe).toBe(true);
  });

  it("grants a later human nothing until they act", async () => {
    const created = await createRoom();
    const withAi = await addAi(created, "Atlas");
    const atlas = withAi.participants.find((participant) => participant.role === "ai");
    await call<RoomSnapshot>(`/api/rooms/${created.room.code}/routing`, {
      ...credential(created),
      aiId: atlas?.id,
      hearsMe: true,
      iHearIt: true,
    });

    const joined = await call<CreateRoomResponse>(`/api/rooms/${created.room.code}/join`, {
      displayName: "Grace",
    });
    const graceRow = joined.value.room.routing.find(
      (row) => row.humanId === joined.value.participant.id && row.aiId === atlas?.id,
    );
    expect(graceRow?.hearsMe).toBe(false);
  });

  it("refuses a routing change without valid participant credentials", async () => {
    const created = await createRoom();
    const room = await addAi(created, "Atlas");
    const atlas = room.participants.find((participant) => participant.role === "ai");
    const { status } = await call(`/api/rooms/${created.room.code}/routing`, {
      participantId: created.participant.id,
      rejoinToken: "not-the-token",
      aiId: atlas?.id,
      hearsMe: true,
      iHearIt: true,
    });
    expect(status).toBe(401);
  });
});

describe("H10 — AI-to-AI off by default and capped", () => {
  it("starts disabled and refuses turns", async () => {
    const created = await createRoom();
    expect(created.room.aiToAi.enabled).toBe(false);
    expect(created.room.aiToAi.turnCap).toBe(AI_TO_AI_TURN_CAP);

    const refused = await call<{ allowed: boolean }>(`/api/rooms/${created.room.code}/ai-to-ai`, {
      ...credential(created),
      operation: "turn",
    });
    expect(refused.value.allowed).toBe(false);
  });

  it("stops the exchange at the cap once a presenter enables it", async () => {
    const created = await createRoom();
    const enabled = await call<RoomSnapshot>(`/api/rooms/${created.room.code}/ai-to-ai`, {
      ...credential(created),
      operation: "enable",
    });
    expect(enabled.value.aiToAi.enabled).toBe(true);

    for (let turn = 0; turn < AI_TO_AI_TURN_CAP; turn += 1) {
      const allowed = await call<{ allowed: boolean }>(`/api/rooms/${created.room.code}/ai-to-ai`, {
        ...credential(created),
        operation: "turn",
      });
      expect(allowed.value.allowed).toBe(true);
    }

    const capped = await call<{ allowed: boolean; room: RoomSnapshot }>(
      `/api/rooms/${created.room.code}/ai-to-ai`,
      { ...credential(created), operation: "turn" },
    );
    expect(capped.value.allowed).toBe(false);
    expect(capped.value.room.aiToAi.cappedAt).not.toBeNull();
  });
});

describe("FR4 — floor control serialises AI speech", () => {
  it("grants the floor once and queues the second AI", async () => {
    const created = await createRoom();
    const first = await addAi(created, "Atlas");
    const second = await addAi(created, "Sage");
    const atlas = first.participants.find((participant) => participant.role === "ai");
    const sage = second.participants.find(
      (participant) => participant.role === "ai" && participant.id !== atlas?.id,
    );

    const granted = await call<{ granted: boolean; room: RoomSnapshot }>(
      `/api/rooms/${created.room.code}/floor`,
      { ...credential(created), aiId: atlas?.id, operation: "request" },
    );
    expect(granted.value.granted).toBe(true);
    expect(granted.value.room.floor.holderId).toBe(atlas?.id);

    const queued = await call<{ granted: boolean; room: RoomSnapshot }>(
      `/api/rooms/${created.room.code}/floor`,
      { ...credential(created), aiId: sage?.id, operation: "request" },
    );
    expect(queued.value.granted).toBe(false);
    expect(queued.value.room.floor.queue).toEqual([sage?.id]);
    // FR4: the waiting AI shows Thinking rather than speaking over the first.
    expect(
      queued.value.room.participants.find((participant) => participant.id === sage?.id)?.pipeline,
    ).toBe("thinking");

    const released = await call<RoomSnapshot>(`/api/rooms/${created.room.code}/floor`, {
      ...credential(created),
      aiId: atlas?.id,
      operation: "release",
    });
    expect(released.value.floor.holderId).toBe(sage?.id);
    expect(released.value.floor.queue).toEqual([]);
  });
});

describe("H11 — presenter simulation is configurable and labelled", () => {
  it("creates the requested counts and labels every simulated participant", async () => {
    const created = await createRoom();
    const configured = await call<RoomSnapshot>(`/api/rooms/${created.room.code}/presenter`, {
      ...credential(created),
      simulatedHumans: 5,
      simulatedAis: 2,
      scriptedResponses: true,
    });

    const simulated = configured.value.participants.filter((participant) => participant.simulated);
    expect(simulated.filter((participant) => participant.role === "human")).toHaveLength(5);
    expect(simulated.filter((participant) => participant.role === "ai")).toHaveLength(2);
    // AGENTS.md: simulation must be unmistakable, including in the name.
    for (const participant of simulated) {
      expect(participant.displayName).toContain("(simulated)");
    }
    expect(configured.value.presenter).toEqual({
      simulatedHumans: 5,
      simulatedAis: 2,
      scriptedResponses: true,
    });
    // The real presenter is never marked simulated.
    expect(
      configured.value.participants.find((participant) => participant.id === created.participant.id)
        ?.simulated,
    ).toBe(false);
  });

  it("reconciles downwards without disturbing the real participant", async () => {
    const created = await createRoom();
    await call<RoomSnapshot>(`/api/rooms/${created.room.code}/presenter`, {
      ...credential(created),
      simulatedHumans: 6,
      simulatedAis: 3,
      scriptedResponses: true,
    });
    const reduced = await call<RoomSnapshot>(`/api/rooms/${created.room.code}/presenter`, {
      ...credential(created),
      simulatedHumans: 1,
      simulatedAis: 0,
      scriptedResponses: false,
    });
    expect(reduced.value.participants.filter((participant) => participant.simulated)).toHaveLength(
      1,
    );
    expect(reduced.value.composition.humans).toBe(2);
    expect(reduced.value.composition.ais).toBe(0);
  });

  it("rejects a simulated count outside the accepted range", async () => {
    const created = await createRoom();
    const { status } = await call(`/api/rooms/${created.room.code}/presenter`, {
      ...credential(created),
      simulatedHumans: MAX_SIMULATED_PARTICIPANTS + 1,
      simulatedAis: 0,
      scriptedResponses: false,
    });
    expect(status).toBe(400);
  });
});

describe("H12 — the rejoin token reclaims one identity, not two", () => {
  it("returns the same participant and keeps its routing rows", async () => {
    const created = await createRoom();
    const withAi = await addAi(created, "Atlas");
    const atlas = withAi.participants.find((participant) => participant.role === "ai");
    await call<RoomSnapshot>(`/api/rooms/${created.room.code}/routing`, {
      ...credential(created),
      aiId: atlas?.id,
      hearsMe: true,
      iHearIt: false,
    });

    await call<RoomSnapshot>(`/api/rooms/${created.room.code}/leave`, credential(created));
    const rejoined = await call<CreateRoomResponse>(`/api/rooms/${created.room.code}/join`, {
      displayName: "Ada Lovelace",
      rejoinToken: created.rejoinToken,
    });

    expect(rejoined.value.participant.id).toBe(created.participant.id);
    expect(rejoined.value.participant.state).toBe("connected");
    // Exactly one human: the reclaim did not create a second participant.
    expect(rejoined.value.room.composition.humans).toBe(1);

    const row = rejoined.value.room.routing.find(
      (entry) => entry.humanId === created.participant.id && entry.aiId === atlas?.id,
    );
    expect(row?.hearsMe).toBe(true);
    expect(row?.iHearIt).toBe(false);
  });

  it("does not reclaim an identity with an unknown token", async () => {
    const created = await createRoom();
    const joined = await call<CreateRoomResponse>(`/api/rooms/${created.room.code}/join`, {
      displayName: "Grace",
      rejoinToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(joined.value.participant.id).not.toBe(created.participant.id);
    expect(joined.value.room.composition.humans).toBe(2);
  });
});

describe("Presenter actions require credentials", () => {
  it("refuses to add an AI without a valid token", async () => {
    const created = await createRoom();
    const { status } = await call(`/api/rooms/${created.room.code}/ai`, {
      participantId: created.participant.id,
      rejoinToken: "not-the-token",
      displayName: "Rogue",
      simulated: false,
    });
    expect(status).toBe(401);
  });

  it("refuses to reshape the simulation without a valid token", async () => {
    const created = await createRoom();
    const { status } = await call(`/api/rooms/${created.room.code}/presenter`, {
      participantId: created.participant.id,
      rejoinToken: "not-the-token",
      simulatedHumans: 3,
      simulatedAis: 1,
      scriptedResponses: true,
    });
    expect(status).toBe(401);
  });
});
