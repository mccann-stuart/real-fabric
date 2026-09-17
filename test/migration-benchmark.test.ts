import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Room } from "../src/worker/room";

describe("Migration Performance Benchmark", () => {
  it("measures migration performance across multiple runs", async () => {
    const rooms = env.ROOMS;
    if (!rooms) throw new Error("ROOMS binding missing");

    const runs = 50;
    let totalTime = 0;

    for (let i = 0; i < runs; i++) {
      const roomCode = `BENCHMIGRATE_${i}_${Date.now()}`;
      const stub = rooms.getByName(roomCode);

      await runInDurableObject(stub, async (instance: Room, state: DurableObjectState) => {
        // Force migration by setting schema version to 1
        state.storage.sql.exec("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
        state.storage.sql.exec("INSERT INTO schema_meta (version) VALUES (1)");

        const roomInstance = instance as unknown as {
          migrate(): void;
        };

        const start = performance.now();
        roomInstance.migrate();
        const duration = performance.now() - start;

        totalTime += duration;

        // Verify that version was updated to 3
        const version = state.storage.sql
          .exec<{ version: number }>("SELECT version FROM schema_meta LIMIT 1")
          .toArray()[0]?.version;
        expect(version).toBe(3);
      });
    }

    const avgMs = totalTime / runs;
    console.log(
      `[BENCHMARK] migrate() execution time avg across ${runs} runs: ${avgMs.toFixed(3)} ms`,
    );
  });
});
