import { describe, expect, it } from "vitest";
import mixerCode from "../public/audio/mixer-worklet.js?raw";

function createMixer() {
  const Processor = class {
    port = { onmessage: null, postMessage: () => {} };
  };
  const Mixer = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "currentTime",
    `${mixerCode}; return RealFabricMixer;`,
  )(Processor, () => {}, 0);
  return new Mixer();
}

function quantum(mixer: ReturnType<typeof createMixer>) {
  const mono = new Float32Array(128);
  const stereo = new Float32Array(128);
  expect(mixer.process([], [[mono, stereo]])).toBe(true);
  expect(stereo).toEqual(mono);
  return mono;
}

describe("mixer render quanta", () => {
  it("mixes and limits active tracks while an empty track leaves their output intact", () => {
    const mixer = createMixer();
    for (const id of ["empty", "first", "second"]) {
      mixer.handle({ type: "add_track", trackId: id });
    }
    for (const id of ["first", "second"]) {
      mixer.handle({ type: "samples", trackId: id, samples: new Float32Array(256).fill(0.75) });
    }
    expect(Array.from(quantum(mixer))).toEqual(Array(128).fill(1));
  });

  it("leaves the depleted remainder silent and resumes when the next quantum receives samples", () => {
    const mixer = createMixer();
    mixer.handle({ type: "add_track", trackId: "short" });
    mixer.handle({ type: "samples", trackId: "short", samples: new Float32Array(3).fill(0.25) });
    const first = quantum(mixer);
    expect(Array.from(first.slice(0, 2))).toEqual([0.25, 0.25]);
    expect(Array.from(first.slice(2))).toEqual(Array(126).fill(0));
    mixer.handle({ type: "samples", trackId: "short", samples: new Float32Array(3).fill(0.5) });
    const resumed = quantum(mixer);
    expect(Array.from(resumed.slice(0, 3))).toEqual([0.25, 0.5, 0.5]);
    expect(Array.from(resumed.slice(3))).toEqual(Array(125).fill(0));
  });

  it("counts one underrun per active starvation run and excludes prebuffering and DTX silence", () => {
    const mixer = createMixer();
    mixer.handle({ type: "add_track", trackId: "voice" });
    mixer.handle({ type: "activity", trackId: "voice", active: true });
    const track = mixer.tracks.get("voice");
    expect(Array.from(quantum(mixer))).toEqual(Array(128).fill(0));
    expect(track.underruns).toBe(0);
    mixer.handle({ type: "samples", trackId: "voice", samples: new Float32Array(129).fill(0.25) });
    quantum(mixer);
    quantum(mixer);
    quantum(mixer);
    expect(track.underruns).toBe(1);
    expect(track.consecutiveUnderrunQuanta).toBe(2);
    mixer.handle({ type: "activity", trackId: "voice", active: false });
    expect(Array.from(quantum(mixer))).toEqual(Array(128).fill(0));
    expect(track.underruns).toBe(1);
    mixer.handle({ type: "flush", trackId: "voice" });
    mixer.handle({ type: "activity", trackId: "voice", active: true });
    expect(Array.from(quantum(mixer))).toEqual(Array(128).fill(0));
    expect(track.underruns).toBe(1);
    mixer.handle({ type: "samples", trackId: "voice", samples: new Float32Array(129).fill(0.25) });
    quantum(mixer);
    quantum(mixer);
    expect(track.underruns).toBe(2);
  });
});
