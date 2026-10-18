import { describe, expect, it } from "vitest";
import type { MixerGraph } from "../src/client/audio/MixerGraph";
import { TrackPlayer } from "../src/client/audio/TrackPlayer";
import { RoomSession, type SessionPhase } from "../src/client/session/RoomSession";

describe("RoomSession Metrics Benchmark", () => {
  it("measures RoomSession.metrics() performance across 20 subscribed players over 100,000 invocations", () => {
    const session = new RoomSession({
      session: {
        code: "BENCHMARKROOMCODE123",
        participantId: "viewer-1",
        rejoinToken: "token-1",
        displayName: "Viewer",
        storedAt: 0,
      },
      presenterMode: false,
      now: () => 1_000,
    });

    const mockMixer = {
      addTrack: () => {},
      removeTrack: () => {},
      setTrackActive: () => {},
      pushSamples: () => {},
      outputClockMs: () => ({ exposed: false, reason: "" }),
      outputLatencyMs: () => ({ exposed: false, reason: "" }),
    } as unknown as MixerGraph;

    const internal = session as unknown as {
      phase: SessionPhase;
      transportReadyAt: number;
      players: Map<string, TrackPlayer>;
      metrics: () => import("../src/client/session/RoomSession").SessionMetrics;
    };

    internal.phase = { name: "live" };
    internal.transportReadyAt = 500;

    // Simulate 20 active players in a room
    for (let i = 0; i < 20; i++) {
      const pid = `participant-${i}`;
      const player = new TrackPlayer(pid, `audio/${pid}`, mockMixer);
      player.accept(1, i + 1, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 1_000);
      internal.players.set(pid, player);
    }

    const iterations = 100_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      internal.metrics();
    }
    const end = performance.now();
    const duration = end - start;

    console.log(
      `[BENCHMARK] RoomSession.metrics (${iterations} ops x 20 players): ${duration.toFixed(2)} ms (avg ${(
        (duration * 1000) / iterations
      ).toFixed(2)} µs per call)`,
    );

    const result = internal.metrics();
    expect(result.subscribedTracks).toEqual({ exposed: true, value: 20 });
    expect(result.activeDecoders).toEqual({ exposed: true, value: 20 });
  });
});
