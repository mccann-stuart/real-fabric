import { describe, expect, it, vi } from "vitest";
import type { MixerGraph } from "../src/client/audio/MixerGraph";
import { PlaybackDeduplicator } from "../src/client/audio/PlaybackDeduplicator";
import { TrackPlayer } from "../src/client/audio/TrackPlayer";
import { parseTrackName } from "../src/shared/tracks";

describe("Track parsing and deduplication benchmark", () => {
  it("benchmarks parseTrackName execution over 100,000 iterations", () => {
    const inputs = [
      "audio/participant-12345",
      "presence/participant-67890",
      "audio/short",
      "presence/a",
      "invalid-track-format",
    ];

    const iterations = 100_000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const input = inputs[i % inputs.length] ?? "";
      parseTrackName(input);
    }

    const duration = performance.now() - start;
    console.log(
      `[BENCHMARK] parseTrackName across ${iterations} ops: ${duration.toFixed(2)} ms (${((duration / iterations) * 1000).toFixed(3)} ns/op)`,
    );

    // Correctness assertions
    expect(parseTrackName("audio/p1")).toEqual({ kind: "audio", participantId: "p1" });
    expect(parseTrackName("presence/p2")).toEqual({ kind: "presence", participantId: "p2" });
    expect(parseTrackName("invalid")).toBeNull();
  });

  it("benchmarks PlaybackDeduplicator accept and prune over 100,000 audio object arrivals", () => {
    const dedupe = new PlaybackDeduplicator();
    const iterations = 100_000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const groupId = Math.floor(i / 50); // 50 objects per second / group
      const objectId = i % 50;
      dedupe.accept("participant-bench", groupId, objectId);
    }

    const duration = performance.now() - start;
    console.log(
      `[BENCHMARK] PlaybackDeduplicator accept/prune across ${iterations} ops: ${duration.toFixed(2)} ms (${((duration / iterations) * 1000).toFixed(3)} ns/op)`,
    );

    // Retained groups bound assertion
    expect(dedupe.retainedGroups("participant-bench")).toBeLessThanOrEqual(4);
  });

  it("benchmarks TrackPlayer cancelGroup over 10,000 barge-in group cancellations", () => {
    const mockMixer = {
      addTrack: vi.fn(),
      removeTrack: vi.fn(),
      pushSamples: vi.fn(),
      setTrackActive: vi.fn(),
      setRatio: vi.fn(),
      flush: vi.fn(),
      outputClockMs: () => ({ exposed: true, value: 0 }),
    } as unknown as MixerGraph;

    const dedupe = new PlaybackDeduplicator();
    const player = new TrackPlayer("p1", "track-1", mockMixer, {}, dedupe);

    const cancellations = 10_000;
    const start = performance.now();

    for (let g = 0; g < cancellations; g++) {
      player.cancelGroup(g);
    }

    const duration = performance.now() - start;
    console.log(
      `[BENCHMARK] TrackPlayer cancelGroup across ${cancellations} ops: ${duration.toFixed(2)} ms (${((duration / cancellations) * 1000).toFixed(3)} ns/op)`,
    );
  });
});
