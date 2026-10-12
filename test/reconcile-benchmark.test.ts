import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CreateRoomResponse, RoomSnapshot } from "../src/shared/contracts";

const BASE = "https://real-fabric.test";
let addressCounter = 800;

async function createRoom(displayName = "BenchmarkHost"): Promise<CreateRoomResponse> {
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

describe("reconcileSimulated Benchmark", () => {
  it("upgrades existing version-4 rooms without losing membership or routing", async () => {
    const created = await createRoom("MigrationHost");
    const rooms = env.ROOMS;
    if (!rooms) throw new Error("Missing ROOMS binding");
    const creds = { participantId: created.participant.id, rejoinToken: created.rejoinToken };
    const configured = await call<RoomSnapshot>(`/api/rooms/${created.room.code}/presenter`, {
      ...creds,
      simulatedHumans: 1,
      simulatedAis: 1,
      scriptedResponses: true,
    });
    expect(configured.status).toBe(200);
    const stub = rooms.getByName(created.room.code);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec("DROP INDEX idx_routing_ai_hears");
      state.storage.sql.exec("UPDATE schema_meta SET version = 4");
      const snapshot = await instance.getSnapshot(creds);
      expect(snapshot?.routing).toEqual(configured.value.routing);
      expect(snapshot?.participants).toEqual(configured.value.participants);
      expect(snapshot?.participants.map((participant) => participant.id)).toContain(
        created.participant.id,
      );
      expect(state.storage.sql.exec("SELECT version FROM schema_meta").one().version).toBe(5);
      expect(
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_routing_ai_hears'",
          )
          .toArray(),
      ).toHaveLength(1);
    });
  });

  it("measures configurePresenter execution time for 24 simulated humans and 17 simulated AIs across multiple runs", async () => {
    const iterations = 5;
    let totalMs = 0;

    for (let i = 0; i < iterations; i++) {
      const created = await createRoom(`Host_${i}`);
      const creds = { participantId: created.participant.id, rejoinToken: created.rejoinToken };

      const start = performance.now();
      const result = await call<RoomSnapshot>(`/api/rooms/${created.room.code}/presenter`, {
        ...creds,
        simulatedHumans: 24,
        simulatedAis: 17,
        scriptedResponses: true,
      });
      const durationMs = performance.now() - start;
      totalMs += durationMs;

      expect(result.status).toBe(200);
      expect(result.value.presenter.simulatedHumans).toBe(24);
      expect(result.value.presenter.simulatedAis).toBe(17);
      expect(
        result.value.participants.filter(
          (participant) => participant.role === "human" && participant.simulated,
        ),
      ).toHaveLength(24);
      expect(
        result.value.participants.filter(
          (participant) => participant.role === "ai" && participant.simulated,
        ),
      ).toHaveLength(17);
    }

    const avgMs = totalMs / iterations;
    console.log(
      `[BENCHMARK] configurePresenter avg (${iterations} runs, 24 humans + 17 AIs): ${avgMs.toFixed(2)} ms`,
    );
  });
});
