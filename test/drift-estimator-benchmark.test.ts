import { describe, expect, it } from "vitest";
import { DriftEstimator } from "../src/client/audio/DriftEstimator";

describe("DriftEstimator Benchmark", () => {
  it("measures observe performance under steady audio stream", () => {
    const estimator = new DriftEstimator("track-1");
    const iterations = 50_000;

    const start = performance.now();
    let mediaTime = 1000;
    let outputTime = 1000;

    for (let i = 0; i < iterations; i++) {
      // Audio frames arrive every 20ms (50Hz)
      mediaTime += 20;
      outputTime += 20.001; // slight drift
      estimator.observe(mediaTime, outputTime);
    }
    const end = performance.now();
    const duration = end - start;

    expect(estimator.hasEstimate).toBe(true);
    console.log(
      `[BENCHMARK] DriftEstimator observe (${iterations} frames): ${duration.toFixed(2)} ms`,
    );
  });
});
