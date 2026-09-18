import { describe, expect, it } from "vitest";
import { DriftEstimator } from "../src/client/audio/DriftEstimator";

describe("DriftEstimator Benchmark", () => {
  it("measures observe execution time over a full 20-second sample window across many iterations", () => {
    const estimator = new DriftEstimator("benchmark-track");

    // Populate estimator with 80 samples (20 seconds at 250ms interval)
    for (let i = 0; i < 80; i++) {
      const timeMs = i * 250;
      // Simulate 100 ppm clock skew
      const mediaMs = timeMs * 1.0001;
      estimator.observe(mediaMs, timeMs);
    }

    expect(estimator.hasEstimate).toBe(true);

    const iterations = 10_000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const timeMs = 20_000 + i * 250;
      const mediaMs = timeMs * 1.0001;
      estimator.observe(mediaMs, timeMs);
    }

    const durationMs = performance.now() - start;
    console.log(
      `[BENCHMARK] DriftEstimator.observe (${iterations} ops with full window): ${durationMs.toFixed(2)} ms`,
    );
  });
});
