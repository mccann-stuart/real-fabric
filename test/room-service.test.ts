import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AI_TO_AI_TURN_CAP,
  type ApiError,
  type CreateRoomResponse,
  type JoinRoomResponse,
  MAX_SIMULATED_PARTICIPANTS,
  REJOIN_WINDOW_MS,
  ROOM_LIFETIME_MS,
  type RoomSnapshot,
} from "../src/shared/contracts";
import type { Room } from "../src/worker/room";
import { decodeRoomError } from "../src/worker/roomError";

const BASE = "https://real-fabric.test";
const TEST_RELAY_TOKEN =
  "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJleHAiOjQxMDI0NDQ4MDB9.test-signature";
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
  addressCounter += 1;
  const response = await SELF.fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `192.0.2.${addressCounter % 250}`,
    },
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

/** The shareable projection anyone with the room code can read. */
async function publicSnapshot(code: string): Promise<RoomSnapshot> {
  const response = await SELF.fetch(`${BASE}/api/rooms/${code}`);
  expect(response.status).toBe(200);
  return (await response.json()) as RoomSnapshot;
}

/** The creator's own authenticated projection, including their routing rows. */
async function ownerSnapshot(created: CreateRoomResponse): Promise<RoomSnapshot> {
  const { status, value } = await call<RoomSnapshot>(
    `/api/rooms/${created.room.code}/snapshot`,
    credential(created),
  );
  expect(status).toBe(200);
  return value;
}

describe("FR1 — the room's hard stop is the pinned lifetime", () => {
  it("expires exactly ROOM_LIFETIME_MS after it is created", async () => {
    // FR1 fixes the hard stop at twenty minutes. Comparing the room against the
    // constant alone would let both move together, so the value is pinned too.
    expect(ROOM_LIFETIME_MS).toBe(20 * 60_000);

    const created = await createRoom();
    expect(created.room.expiresAt - created.room.createdAt).toBe(ROOM_LIFETIME_MS);

    // The shareable snapshot publishes the same window, so a lifetime widened
    // anywhere in the room service cannot hide behind the create response.
    const shared = await publicSnapshot(created.room.code);
    expect(shared.expiresAt - shared.createdAt).toBe(ROOM_LIFETIME_MS);
  });
});

describe("H1 — transport is never claimed before it is traced", () => {
  it("attempts the configured draft without claiming it has been traced", async () => {
    const created = await createRoom();
    // §11.2: configured, so a real session is attempted on the pinned draft.
    expect(created.room.transport.availability).toBe("available");
    expect(created.room.transport.failure).toBeNull();
    expect(created.room.transport.draft).toBe("16");
    expect(created.room.transport.endpointName).toBe("draft-16.example.invalid");
    // Gate 1 has not run, and the reason says so in as many words rather than
    // presenting a configured endpoint as a verified one.
    expect(created.room.transport.traceVerified).toBe(false);
    expect(created.room.transport.reason).toMatch(/not.*claimed as verified/i);
  });

  it("returns the provisioned relay credential only at join", async () => {
    const created = await createRoom();
    // Cloudflare validates a token provisioned against its isolated relay; an
    // application-signed claim would be ignored by that authentication layer.
    expect(created.relayCredential).toBe(TEST_RELAY_TOKEN);
    const credential = created.relayCredential as string;

    // It must never be readable from the shareable snapshot (§8 link separation).
    const snapshot = await SELF.fetch(`https://real-fabric.test/api/rooms/${created.room.code}`);
    expect(JSON.stringify(await snapshot.json())).not.toContain(credential);
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
    if (!atlas) throw new Error("Expected Atlas to be present.");
    const { status, value } = await call<ApiError>(`/api/rooms/${created.room.code}/routing`, {
      participantId: created.participant.id,
      rejoinToken: "not-the-token",
      aiId: atlas.id,
      hearsMe: true,
      iHearIt: false,
    });
    expect(status).toBe(401);
    expect(value.error?.code).toBe("participant_auth_failed");

    // §8: the refusal has to precede the write, so re-read the row rather than
    // trust the status. Consent is still withheld and outbound is untouched.
    const after = await ownerSnapshot(created);
    const row = after.routing.find((entry) => entry.aiId === atlas.id);
    expect(row?.hearsMe).toBe(false);
    expect(row?.iHearIt).toBe(true);
    // H9's anonymous badge still reports the AI as short of context.
    expect(after.partialContextAiIds).toEqual([atlas.id]);
  });

  it("keeps detailed routing out of public snapshots while exposing anonymous partial context (SEC-04)", async () => {
    const created = await createRoom();
    const room = await addAi(created, "Atlas");
    const atlas = room.participants.find((participant) => participant.role === "ai");
    if (!atlas) throw new Error("Expected Atlas to be present.");

    const initialPublicResponse = await SELF.fetch(`${BASE}/api/rooms/${created.room.code}`);
    expect(initialPublicResponse.status).toBe(200);
    const initialPublicSnapshot = (await initialPublicResponse.json()) as RoomSnapshot;
    expect(initialPublicSnapshot.routing).toEqual([]);
    expect(initialPublicSnapshot.partialContextAiIds).toEqual([atlas.id]);

    await call<RoomSnapshot>(`/api/rooms/${created.room.code}/routing`, {
      ...credential(created),
      aiId: atlas.id,
      hearsMe: true,
      iHearIt: true,
    });

    const publicResponse = await SELF.fetch(`${BASE}/api/rooms/${created.room.code}`);
    expect(publicResponse.status).toBe(200);
    const publicSnapshot = (await publicResponse.json()) as RoomSnapshot;
    expect(publicSnapshot.routing).toEqual([]);
    expect(publicSnapshot.partialContextAiIds).toEqual([]);
  });

  it("scopes join and authenticated refresh snapshots to the viewing human (SEC-04)", async () => {
    const created = await createRoom();
    const room = await addAi(created, "Atlas");
    const atlas = room.participants.find((participant) => participant.role === "ai");
    if (!atlas) throw new Error("Expected Atlas to be present.");

    await call<RoomSnapshot>(`/api/rooms/${created.room.code}/routing`, {
      ...credential(created),
      aiId: atlas.id,
      hearsMe: true,
      iHearIt: false,
    });

    const joinedGrace = await call<CreateRoomResponse>(`/api/rooms/${created.room.code}/join`, {
      displayName: "Grace",
    });

    expect(joinedGrace.value.room.routing).toHaveLength(1);
    expect(joinedGrace.value.room.routing[0]).toMatchObject({
      humanId: joinedGrace.value.participant.id,
      aiId: atlas.id,
      hearsMe: false,
      iHearIt: true,
    });
    expect(joinedGrace.value.room.partialContextAiIds).toEqual([atlas.id]);

    const ownerSnapshot = await call<RoomSnapshot>(
      `/api/rooms/${created.room.code}/snapshot`,
      credential(created),
    );
    expect(ownerSnapshot.status).toBe(200);
    expect(ownerSnapshot.value.routing).toHaveLength(1);
    expect(ownerSnapshot.value.routing[0]).toMatchObject({
      humanId: created.participant.id,
      aiId: atlas.id,
      hearsMe: true,
      iHearIt: false,
    });

    const graceSnapshot = await call<RoomSnapshot>(
      `/api/rooms/${created.room.code}/snapshot`,
      credential(joinedGrace.value),
    );
    expect(graceSnapshot.status).toBe(200);
    expect(graceSnapshot.value.routing).toHaveLength(1);
    expect(graceSnapshot.value.routing[0]?.humanId).toBe(joinedGrace.value.participant.id);
  });

  it("refuses an authenticated snapshot forged from a publicly listed participant id (SEC-04)", async () => {
    const created = await createRoom();
    const room = await addAi(created, "Atlas");
    const atlas = room.participants.find((participant) => participant.role === "ai");
    if (!atlas) throw new Error("Expected Atlas to be present.");

    await call<RoomSnapshot>(`/api/rooms/${created.room.code}/routing`, {
      ...credential(created),
      aiId: atlas.id,
      hearsMe: true,
      iHearIt: false,
    });

    // Anyone holding the room code can read participant ids, so a forged
    // snapshot request needs nothing beyond a guess at the rejoin token.
    const shared = await publicSnapshot(created.room.code);
    const victimId = shared.participants.find((participant) => participant.role === "human")?.id;
    if (!victimId) throw new Error("Expected the victim's id to be publicly listed.");
    expect(victimId).toBe(created.participant.id);

    const forged = await call<ApiError & Partial<RoomSnapshot>>(
      `/api/rooms/${created.room.code}/snapshot`,
      { participantId: victimId, rejoinToken: "not-the-token" },
    );
    expect(forged.status).toBe(401);
    expect(forged.value.error?.code).toBe("participant_auth_failed");

    // The refusal must carry no projection at all: a snapshot that skipped the
    // human assertion would hand the victim's private rows to the forger.
    expect(forged.value.routing).toBeUndefined();
    expect(forged.value.participants).toBeUndefined();
    const serialised = JSON.stringify(forged.value);
    expect(serialised).not.toContain(atlas.id);
    expect(serialised).not.toContain(victimId);
    expect(serialised).not.toContain("hearsMe");
  });

  it("refuses presenter and AI lifecycle controls to a second joined human (SEC-02)", async () => {
    const created = await createRoom();
    const joined = await call<JoinRoomResponse>(`/api/rooms/${created.room.code}/join`, {
      displayName: "Attendee",
    });

    const secondHumanId = joined.value.participant.id;
    const secondHumanToken = joined.value.rejoinToken;

    // Second human should receive 403 presenter_only when trying presenter actions
    const addAiRes = await call<ApiError>(`/api/rooms/${created.room.code}/ai`, {
      participantId: secondHumanId,
      rejoinToken: secondHumanToken,
      displayName: "Rogue AI",
      simulated: false,
    });
    expect(addAiRes.status).toBe(403);
    expect(addAiRes.value.error?.code).toBe("presenter_only");

    // A refused presenter action must not have written before it authorised:
    // the rogue AI is absent from the room, not merely absent from the reply.
    const afterAddAi = await publicSnapshot(created.room.code);
    expect(afterAddAi.participants.map((participant) => participant.displayName)).not.toContain(
      "Rogue AI",
    );
    expect(afterAddAi.participants.some((participant) => participant.role === "ai")).toBe(false);
    expect(afterAddAi.participants).toHaveLength(2);

    const presenterRes = await call<ApiError>(`/api/rooms/${created.room.code}/presenter`, {
      participantId: secondHumanId,
      rejoinToken: secondHumanToken,
      simulatedHumans: 2,
      simulatedAis: 2,
      scriptedResponses: true,
    });
    expect(presenterRes.status).toBe(403);
    expect(presenterRes.value.error?.code).toBe("presenter_only");

    const afterPresenter = await publicSnapshot(created.room.code);
    expect(afterPresenter.presenter).toEqual({
      simulatedHumans: 0,
      simulatedAis: 0,
      scriptedResponses: false,
    });
    expect(afterPresenter.participants.some((participant) => participant.simulated)).toBe(false);
    expect(afterPresenter.participants).toHaveLength(2);

    // Room owner / presenter can successfully perform presenter actions
    const ownerAddAiRes = await call(`/api/rooms/${created.room.code}/ai`, {
      participantId: created.participant.id,
      rejoinToken: created.rejoinToken,
      displayName: "Legit AI",
      simulated: false,
    });
    expect(ownerAddAiRes.status).toBe(201);
  });
});

describe("Activity endpoint authorization", () => {
  it("allows a participant to update their own active state", async () => {
    const created = await createRoom();
    const { status } = await call(`/api/rooms/${created.room.code}/active`, {
      participantId: created.participant.id,
      rejoinToken: created.rejoinToken,
      targetId: created.participant.id,
    });
    expect(status).toBe(204);
  });

  it("refuses to update another participant's active state", async () => {
    const created = await createRoom();
    const joined = await call<CreateRoomResponse>(`/api/rooms/${created.room.code}/join`, {
      displayName: "Grace",
    });
    const otherId = joined.value.participant.id;

    const { status } = await call(`/api/rooms/${created.room.code}/active`, {
      participantId: created.participant.id,
      rejoinToken: created.rejoinToken,
      targetId: otherId,
    });
    expect(status).toBe(403);
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

  it("rejects floor requests and releases for invalid or non-AI targets", async () => {
    const created = await createRoom();

    // The status alone would not distinguish "no such AI" from "no such room",
    // and the client renders the specific §10 failure from the code.
    const nonExistent = await call<ApiError>(`/api/rooms/${created.room.code}/floor`, {
      ...credential(created),
      aiId: "non-existent-ai",
      operation: "request",
    });
    expect(nonExistent.status).toBe(404);
    expect(nonExistent.value.error?.code).toBe("ai_not_found");

    const humanTarget = await call<ApiError>(`/api/rooms/${created.room.code}/floor`, {
      ...credential(created),
      aiId: created.participant.id,
      operation: "request",
    });
    expect(humanTarget.status).toBe(404);
    expect(humanTarget.value.error?.code).toBe("ai_not_found");

    const releaseNonExistent = await call<ApiError>(`/api/rooms/${created.room.code}/floor`, {
      ...credential(created),
      aiId: "non-existent-ai",
      operation: "release",
    });
    expect(releaseNonExistent.status).toBe(404);
    expect(releaseNonExistent.value.error?.code).toBe("ai_not_found");
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

  it("accepts the cap itself and creates every simulated participant", async () => {
    const created = await createRoom();
    const configured = await call<RoomSnapshot>(`/api/rooms/${created.room.code}/presenter`, {
      ...credential(created),
      simulatedHumans: MAX_SIMULATED_PARTICIPANTS,
      simulatedAis: MAX_SIMULATED_PARTICIPANTS,
      scriptedResponses: false,
    });
    expect(configured.status).toBe(200);
    expect(configured.value.presenter).toEqual({
      simulatedHumans: MAX_SIMULATED_PARTICIPANTS,
      simulatedAis: MAX_SIMULATED_PARTICIPANTS,
      scriptedResponses: false,
    });

    // The cap is a count the room honours, not merely a number it records: a
    // narrower accepted range would refuse this, and a lower internal clamp
    // would leave the participants missing.
    const simulated = configured.value.participants.filter((participant) => participant.simulated);
    expect(simulated.filter((participant) => participant.role === "human")).toHaveLength(
      MAX_SIMULATED_PARTICIPANTS,
    );
    expect(simulated.filter((participant) => participant.role === "ai")).toHaveLength(
      MAX_SIMULATED_PARTICIPANTS,
    );
  });

  it("rejects a simulated count outside the accepted range", async () => {
    const created = await createRoom();
    const humans = await call<ApiError>(`/api/rooms/${created.room.code}/presenter`, {
      ...credential(created),
      simulatedHumans: MAX_SIMULATED_PARTICIPANTS + 1,
      simulatedAis: 0,
      scriptedResponses: false,
    });
    expect(humans.status).toBe(400);
    expect(humans.value.error?.code).toBe("invalid_request");

    const ais = await call<ApiError>(`/api/rooms/${created.room.code}/presenter`, {
      ...credential(created),
      simulatedHumans: 0,
      simulatedAis: MAX_SIMULATED_PARTICIPANTS + 1,
      scriptedResponses: false,
    });
    expect(ais.status).toBe(400);
    expect(ais.value.error?.code).toBe("invalid_request");
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

  it("stops reclaiming once the rejoin window has passed", async () => {
    // H12's window is sixty seconds, not an open-ended grace period.
    expect(REJOIN_WINDOW_MS).toBe(60_000);

    const created = await createRoom();
    await call<RoomSnapshot>(`/api/rooms/${created.room.code}/leave`, credential(created));

    const rooms = env.ROOMS;
    if (!rooms) throw new Error("The ROOMS binding is required.");
    const stub = rooms.getByName(created.room.code);
    await runInDurableObject(stub, async (_instance: Room, state: DurableObjectState) => {
      const row = state.storage.sql
        .exec<{ reconnect_until: number | null }>(
          "SELECT reconnect_until FROM participants WHERE id = ?",
          created.participant.id,
        )
        .toArray()[0];
      // Leaving opens a bounded window, not an open-ended one. Both bounds are
      // read against the room's own clock, so no cross-isolate skew is involved.
      expect(row?.reconnect_until).not.toBeNull();
      expect(row?.reconnect_until).toBeGreaterThan(Date.now());
      expect(row?.reconnect_until).toBeLessThanOrEqual(Date.now() + REJOIN_WINDOW_MS);

      // Push the deadline 1ms into the past. Only a widened reclaim predicate
      // would still hand the identity back.
      state.storage.sql.exec(
        "UPDATE participants SET reconnect_until = ? WHERE id = ?",
        Date.now() - 1,
        created.participant.id,
      );
    });

    const rejoined = await call<CreateRoomResponse>(`/api/rooms/${created.room.code}/join`, {
      displayName: "Ada Lovelace",
      rejoinToken: created.rejoinToken,
    });
    expect(rejoined.status).toBe(200);
    expect(rejoined.value.participant.id).not.toBe(created.participant.id);
    // A fresh identity comes with a fresh credential, never the expired one.
    expect(rejoined.value.rejoinToken).not.toBe(created.rejoinToken);
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
    const { status, value } = await call<ApiError>(`/api/rooms/${created.room.code}/ai`, {
      participantId: created.participant.id,
      rejoinToken: "not-the-token",
      displayName: "Rogue",
      simulated: false,
    });
    expect(status).toBe(401);
    expect(value.error?.code).toBe("participant_auth_failed");

    // Authorisation has to come before the insert, so re-read the room: the
    // rogue AI is absent from the membership, not just from the reply.
    const after = await publicSnapshot(created.room.code);
    expect(after.participants.map((participant) => participant.displayName)).not.toContain("Rogue");
    expect(after.participants.some((participant) => participant.role === "ai")).toBe(false);
    expect(after.participants).toHaveLength(1);
    expect(after.composition).toEqual({ humans: 1, ais: 0, valid: true });
  });

  it("refuses to reshape the simulation without a valid token", async () => {
    const created = await createRoom();
    const { status, value } = await call<ApiError>(`/api/rooms/${created.room.code}/presenter`, {
      participantId: created.participant.id,
      rejoinToken: "not-the-token",
      simulatedHumans: 3,
      simulatedAis: 1,
      scriptedResponses: true,
    });
    expect(status).toBe(401);
    expect(value.error?.code).toBe("participant_auth_failed");

    // Neither the stored configuration nor the membership moved.
    const after = await ownerSnapshot(created);
    expect(after.presenter).toEqual({
      simulatedHumans: 0,
      simulatedAis: 0,
      scriptedResponses: false,
    });
    expect(after.participants.some((participant) => participant.simulated)).toBe(false);
    expect(after.participants).toHaveLength(1);
  });
});

describe("Room state and error paths (meta, assertActive, schema migration)", () => {
  it("handles uninitialised room state gracefully in assertActive, getSnapshot, fetch, and alarm", async () => {
    const rooms = env.ROOMS;
    if (!rooms) throw new Error("The ROOMS binding is required.");
    const stub = rooms.getByName("UNINITROOMCODE123456");

    await runInDurableObject(stub, async (instance: Room) => {
      const roomInstance = instance as unknown as {
        assertActive(): void;
      };

      try {
        roomInstance.assertActive();
        expect.fail("Expected assertActive to throw");
      } catch (err) {
        expect(decodeRoomError(err as Error)).toEqual({
          status: 404,
          code: "room_not_found",
          message: "Room is not initialised.",
        });
      }

      const snapshot = await instance.getSnapshot();
      expect(snapshot).toBeNull();

      await expect(instance.alarm()).resolves.toBeUndefined();
    });

    const response = await SELF.fetch(
      "https://real-fabric.test/api/rooms/UNINITROOMCODE123456/events",
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Room not found.");
  });

  it("handles catch block in meta() when SQL execution throws an exception", async () => {
    const rooms = env.ROOMS;
    if (!rooms) throw new Error("The ROOMS binding is required.");
    const stub = rooms.getByName("SQL_ERROR_ROOM_CODE");

    await runInDurableObject(stub, async (instance: Room, state: DurableObjectState) => {
      // Create schema_meta with version = 3 so migration is not triggered,
      // but leave room_meta missing so querying SELECT * FROM room_meta throws SQL error.
      state.storage.sql.exec("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
      state.storage.sql.exec("INSERT INTO schema_meta (version) VALUES (3)");

      const roomInstance = instance as unknown as {
        meta(): unknown;
        assertActive(): void;
      };

      expect(roomInstance.meta()).toBeUndefined();

      try {
        roomInstance.assertActive();
        expect.fail("Expected assertActive to throw");
      } catch (err) {
        expect(decodeRoomError(err as Error)).toEqual({
          status: 404,
          code: "room_not_found",
          message: "Room is not initialised.",
        });
      }
    });
  });

  it("handles expired room state in assertActive, getSnapshot, fetch, and alarm", async () => {
    const created = await createRoom();
    const rooms = env.ROOMS;
    if (!rooms) throw new Error("The ROOMS binding is required.");
    const stub = rooms.getByName(created.room.code);

    await runInDurableObject(stub, async (instance: Room, state: DurableObjectState) => {
      // Force expires_at to past timestamp
      state.storage.sql.exec(
        "UPDATE room_meta SET expires_at = ? WHERE singleton = 1",
        Date.now() - 1000,
      );

      const roomInstance = instance as unknown as {
        assertActive(): void;
      };

      try {
        roomInstance.assertActive();
        expect.fail("Expected assertActive to throw");
      } catch (err) {
        expect(decodeRoomError(err as Error)).toEqual({
          status: 410,
          code: "room_expired",
          message: "Room has expired.",
        });
      }

      const snapshot = await instance.getSnapshot();
      expect(snapshot).toBeNull();

      await instance.alarm();

      const metaRow = state.storage.sql
        .exec<{ expires_at: number; floor_holder: string | null }>(
          "SELECT expires_at, floor_holder FROM room_meta WHERE singleton = 1",
        )
        .toArray()[0];
      expect(metaRow?.floor_holder).toBeNull();
    });

    const response = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(410);
    expect(await response.text()).toBe("Room expired.");
  });

  it("triggers schema migration in meta() when schema_meta version is outdated", async () => {
    const rooms = env.ROOMS;
    if (!rooms) throw new Error("The ROOMS binding is required.");
    const stub = rooms.getByName("MIGRATE_ROOM_CODE");

    await runInDurableObject(stub, async (instance: Room, state: DurableObjectState) => {
      state.storage.sql.exec("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
      state.storage.sql.exec("INSERT INTO schema_meta (version) VALUES (1)");

      const roomInstance = instance as unknown as {
        meta(): unknown;
      };

      const meta = roomInstance.meta();
      expect(meta).toBeUndefined();

      const currentVersion = state.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_meta LIMIT 1")
        .toArray()[0]?.version;
      expect(currentVersion).toBe(3);
    });
  });
});
