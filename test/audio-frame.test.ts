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
});
