import { SELF } from "cloudflare:test";
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
  it("measures configurePresenter execution time for 24 simulated humans and 24 simulated AIs across multiple runs", async () => {
    const iterations = 5;
    let totalMs = 0;

    for (let i = 0; i < iterations; i++) {
      const created = await createRoom(`Host_${i}`);
      const creds = { participantId: created.participant.id, rejoinToken: created.rejoinToken };

      const start = performance.now();
      const result = await call<RoomSnapshot>(`/api/rooms/${created.room.code}/presenter`, {
        ...creds,
        simulatedHumans: 24,
        simulatedAis: 24,
        scriptedResponses: true,
      });
      const durationMs = performance.now() - start;
      totalMs += durationMs;

      expect(result.status).toBe(200);
      expect(result.value.presenter.simulatedHumans).toBe(24);
      expect(result.value.presenter.simulatedAis).toBe(24);
    }

    const avgMs = totalMs / iterations;
    console.log(
      `[BENCHMARK] configurePresenter avg (${iterations} runs, 24 humans + 24 AIs): ${avgMs.toFixed(2)} ms`,
    );
  });
});
