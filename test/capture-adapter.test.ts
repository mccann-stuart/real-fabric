import { describe, expect, it } from "vitest";
import {
  CAPTURE_FRAME_SAMPLES,
  inspectCaptureSupport,
  PcmFrameAssembler,
} from "../src/client/audio/UniversalAudioCaptureAdapter";

describe("Standards §6 — universal audio capture boundary", () => {
  it("keeps MediaStreamTrackProcessor as the preferred fast path", () => {
    const support = inspectCaptureSupport({
      AudioData: class {} as unknown as typeof AudioData,
      MediaStreamTrackProcessor: class {} as never,
      AudioContext: class {} as unknown as typeof AudioContext,
      AudioWorkletNode: class {} as unknown as typeof AudioWorkletNode,
    });

    expect(support).toMatchObject({ available: true, path: "track_processor" });
  });

  it("selects AudioWorklet when the Chromium-only processor is absent", () => {
    const support = inspectCaptureSupport({
      AudioData: class {} as unknown as typeof AudioData,
      AudioContext: class {} as unknown as typeof AudioContext,
      AudioWorkletNode: class {} as unknown as typeof AudioWorkletNode,
    });

    expect(support).toMatchObject({ available: true, path: "audio_worklet" });
  });

  it("reports the missing capture capability instead of claiming a fallback", () => {
    expect(inspectCaptureSupport({ AudioData: class {} as unknown as typeof AudioData })).toEqual({
      available: false,
      path: null,
      reason:
        "Neither MediaStreamTrackProcessor nor AudioWorklet microphone capture is exposed by this browser.",
    });
  });

  it("aggregates render quanta into exact 960-sample frames", () => {
    const assembler = new PcmFrameAssembler();
    const frames: Array<{ samples: Float32Array; timestamp: number }> = [];
    for (let quantum = 0; quantum < 15; quantum += 1) {
      const samples = new Float32Array(128).fill(quantum + 1);
      assembler.push(samples, 1_000_000 + quantum * (128 / 48_000) * 1_000_000, (pcm, at) => {
        frames.push({ samples: pcm, timestamp: at });
      });
    }

    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.samples.length === CAPTURE_FRAME_SAMPLES)).toBe(true);
    expect(frames.map((frame) => frame.timestamp)).toEqual([1_000_000, 1_020_000]);
    expect(frames[0]?.samples[0]).toBe(1);
    expect(frames[0]?.samples[CAPTURE_FRAME_SAMPLES - 1]).toBe(8);
  });

  it("resets partial storage and the media timestamp together", () => {
    const assembler = new PcmFrameAssembler();
    const timestamps: number[] = [];
    assembler.push(new Float32Array(480), 10_000, () => undefined);
    assembler.reset();
    assembler.push(new Float32Array(CAPTURE_FRAME_SAMPLES), 50_000, (_samples, at) => {
      timestamps.push(at);
    });

    expect(timestamps).toEqual([50_000]);
  });
});
