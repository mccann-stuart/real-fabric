import { describe, expect, it } from "vitest";
import { PacketLossConcealer } from "../src/client/audio/PacketLossConcealer";
import { PlaybackDeduplicator } from "../src/client/audio/PlaybackDeduplicator";
import { VoiceActivityDetector } from "../src/client/audio/VoiceActivityDetector";

describe("Deduplicate and PacketLossConcealer Benchmark", () => {
  it("measures PlaybackDeduplicator.accept performance over 1,000,000 frame arrivals across group transitions", () => {
    const dedupe = new PlaybackDeduplicator();
    const iterations = 1_000_000;
    const participantId = "participant-bench";

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const groupId = Math.floor(i / 50); // 50 objects per 1-second group
      const objectId = i % 50;
      dedupe.accept(participantId, groupId, objectId);
    }
    const end = performance.now();
    const duration = end - start;

    expect(dedupe.retainedGroups(participantId)).toBeLessThanOrEqual(4);
    console.log(
      `[BENCHMARK] PlaybackDeduplicator.accept (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
  });

  it("measures PacketLossConcealer.observe performance over 1,000,000 20ms audio frames", () => {
    const concealer = new PacketLossConcealer();
    const iterations = 1_000_000;
    const sampleFrame = new Float32Array(960);
    for (let i = 0; i < 960; i++) {
      sampleFrame[i] = Math.sin((i / 960) * Math.PI * 2) * 0.1;
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      concealer.observe(sampleFrame);
    }
    const end = performance.now();
    const duration = end - start;

    expect(concealer.stats.concealedFrames).toBe(0);
    console.log(
      `[BENCHMARK] PacketLossConcealer.observe (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
  });

  it("measures VoiceActivityDetector.observe performance over 1,000,000 capture quanta", () => {
    const detector = new VoiceActivityDetector();
    const iterations = 1_000_000;
    const sampleFrame = new Float32Array(960);
    for (let i = 0; i < 960; i++) {
      sampleFrame[i] = Math.sin((i / 960) * Math.PI * 2) * 0.1;
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      detector.observe(sampleFrame);
    }
    const end = performance.now();
    const duration = end - start;

    expect(detector.level).toBeGreaterThan(0);
    console.log(
      `[BENCHMARK] VoiceActivityDetector.observe (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
  });
});
