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

  it("accurately preserves 64-bit millisecond timestamps matching BigUint64 wire layout", () => {
    const timestamps = [
      0,
      1_000,
      4_294_967_295, // 2^32 - 1 boundary
      4_294_967_296, // 2^32 boundary
      1_710_000_000_000, // realistic epoch timestamp
      Number.MAX_SAFE_INTEGER,
    ];
    for (const mediaTimestamp of timestamps) {
      const payload = new Uint8Array([42]);
      const encoded = encodeAudioObject(
        { participantHash: 12345, mediaTimestamp, sequence: 1 },
        payload,
      );
      // Verify wire layout: bytes 6..14 must match standard 64-bit big-endian representation
      const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
      expect(Number(view.getBigUint64(6))).toBe(mediaTimestamp);

      const decoded = decodeAudioObject(encoded);
      expect(decoded.metadata.mediaTimestamp).toBe(mediaTimestamp);
    }
  });

  it("measures encodeAudioObject and decodeAudioObject throughput", () => {
    const payload = new Uint8Array(80);
    const metadata = {
      participantHash: 0xdeadbeef,
      mediaTimestamp: 1_710_000_000_000,
      sequence: 1234,
      endOfTurn: true,
    };

    const iterations = 50_000;
    const startEncode = performance.now();
    let lastEncoded: Uint8Array | null = null;
    for (let i = 0; i < iterations; i += 1) {
      lastEncoded = encodeAudioObject(metadata, payload);
    }
    const encodeDurationMs = performance.now() - startEncode;

    const startDecode = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      if (lastEncoded) decodeAudioObject(lastEncoded);
    }
    const decodeDurationMs = performance.now() - startDecode;

    console.log(
      `[BENCHMARK] audio-frame throughput (${iterations} ops): encode ${encodeDurationMs.toFixed(2)} ms, decode ${decodeDurationMs.toFixed(2)} ms`,
    );
    expect(encodeDurationMs).toBeGreaterThan(0);
    expect(decodeDurationMs).toBeGreaterThan(0);
  });
});
