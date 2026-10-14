import { describe, expect, it } from "vitest";
import { hasDangerousPrototypeKeys, readJsonObject } from "../src/worker/validation";

describe("Validation Benchmark", () => {
  function createSamplePayload() {
    const sampleObject: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      sampleObject[`key_${i}`] = {
        nested_a: `value_${i}`,
        nested_b: i,
        nested_c: [1, 2, { innerKey: "test" }],
      };
    }
    return sampleObject;
  }

  it("measures hasDangerousPrototypeKeys performance directly", () => {
    const sampleObject = createSamplePayload();
    const iterations = 500_000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      hasDangerousPrototypeKeys(sampleObject);
    }
    const end = performance.now();
    const duration = end - start;

    console.log(
      `[BENCHMARK] hasDangerousPrototypeKeys (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
    expect(duration).toBeGreaterThan(0);
  });

  it("measures readJsonObject performance", async () => {
    const sampleObject = createSamplePayload();
    const jsonString = JSON.stringify(sampleObject);

    const iterations = 10_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const request = new Request("https://example.test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: jsonString,
      });
      await readJsonObject(request);
    }
    const end = performance.now();
    const duration = end - start;

    console.log(`[BENCHMARK] readJsonObject (${iterations} ops): ${duration.toFixed(2)} ms`);
    expect(duration).toBeGreaterThan(0);
  }, 15000);
});
