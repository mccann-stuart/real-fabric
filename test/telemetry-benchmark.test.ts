import { describe, expect, it } from "vitest";
import { SessionTelemetry } from "../src/client/telemetry/SessionTelemetry";

describe("SessionTelemetry Benchmark", () => {
  it("measures SessionTelemetry.record performance over 100,000 event calls beyond capacity", () => {
    const telemetry = new SessionTelemetry();
    const iterations = 100_000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      telemetry.record({
        type: "audio_frame",
        participantId: "p1",
        trackId: "t1",
        value: i,
      });
    }
    const end = performance.now();
    const duration = end - start;

    console.log(
      `[BENCHMARK] SessionTelemetry.record (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
    expect(telemetry.report("test").events).toHaveLength(2000);
  });
});
