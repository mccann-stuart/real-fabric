import { describe, expect, it } from "vitest";
import mixerCode from "../public/audio/mixer-worklet.js?raw";

function loadMixerClass() {
  const dummyAudioWorkletProcessor = class {
    port = { onmessage: null, postMessage: () => {} };
  };
  const fn = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "currentTime",
    `
    ${mixerCode}
    return RealFabricMixer;
  `,
  );
  return fn(dummyAudioWorkletProcessor, () => {}, 0);
}

describe("RealFabricMixer worklet benchmark and correctness", () => {
  it("correctly mixes active audio tracks and breaks early when tracks run out of samples", () => {
    const MixerClass = loadMixerClass();
    const mixer = new MixerClass();

    mixer.handle({ type: "add_track", trackId: "track-1" });
    mixer.handle({ type: "add_track", trackId: "track-2" });

    // Write 256 samples to track-1
    const samples = new Float32Array(256);
    for (let i = 0; i < 256; i++) samples[i] = 0.25;
    mixer.handle({ type: "samples", trackId: "track-1", samples });

    const outputChannel = new Float32Array(128);
    const outputs = [[outputChannel]];

    const active = mixer.process([], outputs);
    expect(active).toBe(true);

    // Track 1 should contribute 0.25 to outputChannel across all 128 frames
    expect(outputChannel[0]).toBeCloseTo(0.25);
    expect(outputChannel[127]).toBeCloseTo(0.25);
  });

  it("benchmarks RealFabricMixer process performance across 100,000 quanta", () => {
    const MixerClass = loadMixerClass();
    const mixer = new MixerClass();

    const trackCount = 10;
    for (let i = 0; i < trackCount; i++) {
      mixer.handle({ type: "add_track", trackId: `track-${i}` });
    }

    const samples = new Float32Array(128);
    for (let i = 0; i < 128; i++) samples[i] = Math.sin(i * 0.1) * 0.1;

    const outputChannel = new Float32Array(128);
    const outputs = [[outputChannel]];
    const quanta = 100_000;

    // Warmup
    for (let q = 0; q < 2000; q++) {
      for (let i = 0; i < 5; i++) {
        mixer.handle({ type: "samples", trackId: `track-${i}`, samples });
      }
      mixer.process([], outputs);
    }

    const start = performance.now();
    for (let q = 0; q < quanta; q++) {
      for (let i = 0; i < 5; i++) {
        mixer.handle({ type: "samples", trackId: `track-${i}`, samples });
      }
      mixer.process([], outputs);
    }
    const durationMs = performance.now() - start;

    console.log(
      `[BENCHMARK] RealFabricMixer.process (100000 quanta, 10 tracks, 5 active/5 silent): ${durationMs.toFixed(2)} ms`,
    );

    expect(durationMs).toBeGreaterThan(0);
  });
});
