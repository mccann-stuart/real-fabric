import { describe, expect, it } from "vitest";
import { DeviceWatcher, type MediaDeviceSource } from "../src/client/audio/DeviceWatcher";
import {
  DriftEstimator,
  MAXIMUM_CORRECTION_RATIO,
  MAXIMUM_STEP_RATIO,
  MINIMUM_CORRECTION_RATIO,
} from "../src/client/audio/DriftEstimator";
import { AUDIO_FRAME_DURATION_MS, encodeAudioObject } from "../src/client/audio/frame";
import { MixerGraph } from "../src/client/audio/MixerGraph";
import {
  COMFORT_NOISE_AFTER_FRAMES,
  estimatePitchPeriod,
  FRAME_SAMPLES,
  PacketLossConcealer,
} from "../src/client/audio/PacketLossConcealer";
import {
  MAXIMUM_REBUILD_DEFERRAL_MS,
  SILENCE_REBUILD_GAP_MS,
  TrackPlayer,
} from "../src/client/audio/TrackPlayer";

/**
 * §11.3 milestone 2: hardware resilience and audio pipeline hardening.
 */

function tone(hz: number, samples = FRAME_SAMPLES): Float32Array {
  const output = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    output[index] = Math.sin((2 * Math.PI * hz * index) / 48_000);
  }
  return output;
}

describe("M2 — packet loss concealment", () => {
  it("conceals nothing before a frame has ever been decoded", () => {
    // Inventing audio at the start of a track would be a fiction, not concealment.
    expect(new PacketLossConcealer().conceal()).toBeNull();
  });

  it("preserves pitch across a short gap rather than inserting silence", () => {
    const concealer = new PacketLossConcealer();
    concealer.observe(tone(200));
    const concealment = concealer.conceal();

    expect(concealment?.kind).toBe("pitch_repeat");
    expect(concealment?.samples).toHaveLength(FRAME_SAMPLES);
    // Non-silent, and carrying the waveform's energy rather than a click.
    const peak = Math.max(...Array.from(concealment?.samples ?? []).map(Math.abs));
    expect(peak).toBeGreaterThan(0.1);
  });

  it("finds the pitch period of a voiced frame", () => {
    // 200 Hz at 48 kHz is a 240-sample period; the coarse search strides by 4.
    expect(estimatePitchPeriod(tone(200))).toBeGreaterThanOrEqual(236);
    expect(estimatePitchPeriod(tone(200))).toBeLessThanOrEqual(244);
  });

  it("decays a held gap instead of buzzing", () => {
    const concealer = new PacketLossConcealer();
    concealer.observe(tone(200));
    const first = peakOf(concealer.conceal()?.samples);
    const second = peakOf(concealer.conceal()?.samples);
    expect(second).toBeLessThan(first);
  });

  it("switches to comfort noise once loss is sustained", () => {
    // §10.5: sustained loss produces comfort noise rather than silence.
    const concealer = new PacketLossConcealer();
    concealer.observe(tone(200));
    for (let index = 0; index < COMFORT_NOISE_AFTER_FRAMES; index += 1) {
      expect(concealer.conceal()?.kind).toBe("pitch_repeat");
    }
    expect(concealer.conceal()?.kind).toBe("comfort_noise");
    expect(concealer.stats.comfortNoiseFrames).toBe(1);
    expect(concealer.stats.concealedFrames).toBe(COMFORT_NOISE_AFTER_FRAMES + 1);
  });

  it("ends the loss run when a real frame arrives", () => {
    const concealer = new PacketLossConcealer();
    concealer.observe(tone(200));
    concealer.conceal();
    concealer.conceal();
    expect(concealer.stats.consecutive).toBe(2);
    concealer.observe(tone(200));
    expect(concealer.stats.consecutive).toBe(0);
  });
});

describe("M2 — drift estimation and silence rebuilding", () => {
  function driftBy(ratio: number): DriftEstimator {
    const estimator = new DriftEstimator("track");
    for (let index = 0; index < 400; index += 1) {
      const media = index * AUDIO_FRAME_DURATION_MS;
      estimator.observe(media, media * ratio);
    }
    return estimator;
  }

  it("treats skew beyond five per cent as uncorrectable, per §10.6", () => {
    expect(MAXIMUM_CORRECTION_RATIO).toBeCloseTo(1.05);
    expect(MINIMUM_CORRECTION_RATIO).toBeCloseTo(0.95);
    expect(driftBy(1.08).health()).toBe("beyond_range");
    expect(driftBy(0.9).health()).toBe("beyond_range");
  });

  it("corrects moderate skew rather than declaring it uncorrectable", () => {
    // 3% is inside the correctable range even though it exceeds one step.
    const estimator = driftBy(1.03);
    expect(estimator.health()).not.toBe("beyond_range");
    expect(estimator.correctionRatio()).toBeGreaterThan(1);
    // Applied slowly: a single step never exceeds the audible bound.
    expect(estimator.correctionRatio()).toBeLessThanOrEqual(MAXIMUM_STEP_RATIO);
  });

  it("exposes no skew figure before it has converged", () => {
    // H15: an unconverged estimator must not read as zero drift.
    expect(new DriftEstimator("track").skewPpm().exposed).toBe(false);
  });
});

describe("M2 — the drift rebuild waits for a pause", () => {
  function stubMixer() {
    const calls: string[] = [];
    const mixer = {
      addTrack: () => calls.push("addTrack"),
      removeTrack: () => calls.push("removeTrack"),
      pushSamples: () => calls.push("pushSamples"),
      setRatio: () => calls.push("setRatio"),
      flush: () => calls.push("flush"),
    } as unknown as MixerGraph;
    return { mixer, calls };
  }

  /**
   * Feeds badly skewed objects. Local time advances 1.2x media time, so the
   * estimator leaves the correctable range, and arrivals stay 24 ms apart —
   * comfortably inside the silence threshold, so this is a continuous speaker.
   */
  function drifted(objects: number) {
    const { mixer } = stubMixer();
    const player = new TrackPlayer("participant", "track", mixer);
    let arrival = 0;
    for (let index = 0; index < objects; index += 1) {
      const media = index * AUDIO_FRAME_DURATION_MS;
      arrival = media * 1.2;
      const payload = encodeAudioObject(
        { participantHash: 1, mediaTimestamp: media, sequence: index },
        new Uint8Array([1, 2, 3]),
      );
      player.accept(1, index, payload, arrival);
    }
    return { player, arrival };
  }

  it("schedules the rebuild instead of tearing the buffer down mid-word", () => {
    expect(drifted(400).player.rebuildPending).toBe(true);
  });

  it("runs the rebuild at the first silence", () => {
    const { player, arrival } = drifted(400);

    // Still speaking: the last object arrived just now, so the rebuild holds.
    player.drain(arrival + SILENCE_REBUILD_GAP_MS - 1);
    expect(player.rebuildPending).toBe(true);

    // A pause. Now it is free to rebuild without an audible artefact.
    player.drain(arrival + SILENCE_REBUILD_GAP_MS);
    expect(player.rebuildPending).toBe(false);
  });

  it("does not let a continuous speaker defer the rebuild forever", () => {
    // Enough objects that local time passes the deferral bound while arrivals
    // stay 24 ms apart, so the track is never silent for long enough to
    // qualify. The rebuild must still happen: a brief artefact beats unbounded
    // skew.
    const objects = Math.ceil(
      (MAXIMUM_REBUILD_DEFERRAL_MS * 1.5) / (AUDIO_FRAME_DURATION_MS * 1.2),
    );
    const { player, arrival } = drifted(objects);
    expect(arrival).toBeGreaterThan(MAXIMUM_REBUILD_DEFERRAL_MS);

    // Drained at the moment of the final arrival: not silent by any measure.
    player.drain(arrival);
    expect(player.rebuildPending).toBe(false);
  });
});

describe("M2 — truthful browser latency reporting", () => {
  it("treats a zero AudioContext output latency as Not exposed", () => {
    const mixer = new MixerGraph();
    const internal = mixer as unknown as { context: { outputLatency: number } };

    internal.context = { outputLatency: 0 };
    expect(mixer.outputLatencyMs().exposed).toBe(false);

    internal.context = { outputLatency: 0.008 };
    expect(mixer.outputLatencyMs()).toEqual({ exposed: true, value: 8 });
  });
});

describe("M2 — dynamic device tracking", () => {
  function fakeDevices(initial: number) {
    let inputs = initial;
    const listeners = new Set<() => void>();
    const source: MediaDeviceSource = {
      enumerateDevices: async () =>
        Array.from({ length: inputs }, () => ({ kind: "audioinput" })).concat([
          { kind: "audiooutput" },
        ]),
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    };
    return {
      source,
      async set(count: number) {
        inputs = count;
        for (const listener of listeners) listener();
        // Let the watcher's async enumeration settle.
        await Promise.resolve();
        await Promise.resolve();
      },
      get listenerCount() {
        return listeners.size;
      },
    };
  }

  it("reports a headset appearing after a listen-only join", async () => {
    const seen: string[] = [];
    const devices = fakeDevices(0);
    const watcher = new DeviceWatcher(
      { onChange: (transition) => seen.push(transition) },
      devices.source,
    );
    await watcher.start();
    expect(watcher.inputCount()).toEqual({ exposed: true, value: 0 });

    await devices.set(1);
    expect(seen).toEqual(["first_input_appeared"]);
    expect(watcher.inputCount()).toEqual({ exposed: true, value: 1 });
    expect(watcher.deviceChanges()).toEqual({ exposed: true, value: 1 });
  });

  it("distinguishes an added device from a removed one", async () => {
    const seen: string[] = [];
    const devices = fakeDevices(1);
    const watcher = new DeviceWatcher(
      { onChange: (transition) => seen.push(transition) },
      devices.source,
    );
    await watcher.start();
    await devices.set(2);
    await devices.set(1);
    expect(seen).toEqual(["input_added", "input_removed"]);
  });

  it("reports Not exposed where the browser enumerates nothing", () => {
    // H15: no enumeration is not the same as no devices.
    const watcher = new DeviceWatcher({}, null);
    expect(watcher.inputCount().exposed).toBe(false);
    expect(watcher.deviceChanges().exposed).toBe(false);
  });

  it("detaches its listener on stop", async () => {
    const devices = fakeDevices(1);
    const watcher = new DeviceWatcher({}, devices.source);
    await watcher.start();
    expect(devices.listenerCount).toBe(1);
    watcher.stop();
    expect(devices.listenerCount).toBe(0);
  });

  it("never reads a device label", async () => {
    // AC-14: labels are not read, so they cannot leak into telemetry.
    const devices = fakeDevices(1);
    const watcher = new DeviceWatcher(
      {},
      {
        ...devices.source,
        enumerateDevices: async () => [
          {
            kind: "audioinput",
            get label(): string {
              throw new Error("A device label was read.");
            },
          } as unknown as { kind: string },
        ],
      },
    );
    await expect(watcher.start()).resolves.toBeUndefined();
    expect(watcher.inputCount()).toEqual({ exposed: true, value: 1 });
  });
});

function peakOf(samples: Float32Array | undefined): number {
  return Math.max(...Array.from(samples ?? [0]).map(Math.abs));
}
