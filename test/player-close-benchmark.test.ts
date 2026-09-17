import { describe, expect, it, vi } from "vitest";
import type { MixerGraph } from "../src/client/audio/MixerGraph";
import { PlaybackDeduplicator } from "../src/client/audio/PlaybackDeduplicator";
import { TrackPlayer } from "../src/client/audio/TrackPlayer";
import { RoomSession } from "../src/client/session/RoomSession";

describe("TrackPlayer and RoomSession close performance benchmark", () => {
  it("measures closing multiple TrackPlayers and clearing players in RoomSession", async () => {
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

    // Create a RoomSession instance
    const session = new RoomSession({
      session: {
        code: "BENCHMARK_ROOM_CODE",
        participantId: "bench-host",
        rejoinToken: "token",
        displayName: "Bench Host",
        storedAt: Date.now(),
      },
      presenterMode: false,
    });

    const playersMap = (session as unknown as { players: Map<string, TrackPlayer> }).players;

    const numPlayers = 50;
    const runs = 1000;

    let totalMs = 0;

    for (let r = 0; r < runs; r++) {
      playersMap.clear();
      for (let i = 0; i < numPlayers; i++) {
        const id = `participant-${i}`;
        playersMap.set(id, new TrackPlayer(id, `track-${i}`, mockMixer, {}, dedupe));
      }

      const start = performance.now();
      await session.close();
      const duration = performance.now() - start;
      totalMs += duration;

      // Reset closed state for next iteration
      (session as unknown as { closed: boolean }).closed = false;
    }

    const avgUs = (totalMs / runs) * 1000;
    console.log(
      `[BENCHMARK] RoomSession.close with ${numPlayers} players: avg ${avgUs.toFixed(2)} µs per call across ${runs} runs`,
    );

    expect(playersMap.size).toBe(0);
    // Clearing the map is not closing the players. TrackPlayer.close() releases
    // its mixer track, so this is what distinguishes real teardown from a
    // forgotten reference that leaves every track summed into the output.
    expect(mockMixer.removeTrack).toHaveBeenCalledTimes(runs * numPlayers);
  });

  it("stays closed and player-free when closed repeatedly with nothing to release", async () => {
    const session = new RoomSession({
      session: {
        code: "BENCHMARK_ROOM_CODE",
        participantId: "bench-host",
        rejoinToken: "token",
        displayName: "Bench Host",
        storedAt: Date.now(),
      },
      presenterMode: false,
    });

    const runs = 10000;
    const start = performance.now();

    for (let r = 0; r < runs; r++) {
      await session.close();
      (session as unknown as { closed: boolean }).closed = false;
    }

    const totalMs = performance.now() - start;
    const avgUs = (totalMs / runs) * 1000;
    console.log(
      `[BENCHMARK] RoomSession.close with 0 players: avg ${avgUs.toFixed(2)} µs per call across ${runs} runs`,
    );

    // Previously this case asserted nothing at all, so it could not fail. A
    // final close, this time without resetting the flag, has to leave the
    // session terminally closed and player-free — proving close() ran through
    // rather than returning early before doing any of its work.
    await session.close();
    expect((session as unknown as { closed: boolean }).closed).toBe(true);
    expect((session as unknown as { players: Map<string, unknown> }).players.size).toBe(0);
  });
});
