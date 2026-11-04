import { describe, expect, it } from "vitest";
import { decodeAudioObject, encodeAudioObject } from "../src/client/audio/frame";

describe("audio object format", () => {
  it("round-trips metadata and an Opus payload", () => {
    const payload = new Uint8Array([1, 3, 5, 7]);
    const encoded = encodeAudioObject(
      { participantHash: 42, mediaTimestamp: 96_000, sequence: 9, endOfTurn: true },
      payload,
    );

    expect(decodeAudioObject(encoded)).toEqual({
      metadata: {
        participantHash: 42,
        mediaTimestamp: 96_000,
        sequence: 9,
        endOfTurn: true,
      },
      opusFrame: payload,
    });
  });

  it("rejects truncated objects", () => {
    expect(() => decodeAudioObject(new Uint8Array(10))).toThrow("shorter than");
  });

  it("preserves both turn-ending and cancellation markers", () => {
    const encoded = encodeAudioObject(
      { participantHash: 7, mediaTimestamp: 1_920, sequence: 3, endOfTurn: true, cancelled: true },
      new Uint8Array([9]),
    );
    expect(decodeAudioObject(encoded).metadata).toEqual({
      participantHash: 7,
      mediaTimestamp: 1_920,
      sequence: 3,
      endOfTurn: true,
      cancelled: true,
    });
  });

  it("accurately round-trips timestamps exceeding 32-bit integer boundaries without precision loss", () => {
    const largeTimestamp = 1_730_720_000_123; // Epoch timestamp > 2^32
    const encoded = encodeAudioObject(
      { participantHash: 999, mediaTimestamp: largeTimestamp, sequence: 1 },
      new Uint8Array([0xaa, 0xbb]),
    );
    const decoded = decodeAudioObject(encoded);
    expect(decoded.metadata.mediaTimestamp).toBe(largeTimestamp);
  });

  it("benchmarks encodeAudioObject and decodeAudioObject over 100,000 frames", () => {
    const payload = new Uint8Array(60); // 60 bytes typical 20ms Opus frame
    const metadata = {
      participantHash: 12345,
      mediaTimestamp: 1_730_720_000_000,
      sequence: 50,
      endOfTurn: false,
    };

    const iterations = 100_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      metadata.sequence = i;
      metadata.mediaTimestamp += 20;
      const encoded = encodeAudioObject(metadata, payload);
      decodeAudioObject(encoded);
    }
    const duration = performance.now() - start;
    console.log(
      `[BENCHMARK] encodeAudioObject + decodeAudioObject (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
    expect(duration).toBeGreaterThan(0);
  });
});
