import { describe, expect, it } from "vitest";
import { DriftEstimator } from "../src/client/audio/DriftEstimator";
import { AUDIO_FRAME_DURATION_MS } from "../src/client/audio/frame";

describe("DriftEstimator Benchmark", () => {
  it("measures observe and robust skew estimation performance across 50,000 observations", () => {
    const estimator = new DriftEstimator("benchmark-track");
    const iterations = 50_000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const media = i * AUDIO_FRAME_DURATION_MS;
      // Simulate 1.002x clock ratio (2000 ppm skew)
      const output = media * 1.002;
      estimator.observe(media, output);
    }
    const end = performance.now();
    const duration = end - start;

    expect(estimator.hasEstimate).toBe(true);
    console.log(
      `[BENCHMARK] DriftEstimator observe (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
  });
});
