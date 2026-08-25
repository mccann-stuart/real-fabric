export const AUDIO_FORMAT_VERSION = 1;
export const AUDIO_FRAME_DURATION_MS = 20;
export const AUDIO_OBJECT_HEADER_BYTES = 22;

export interface AudioFrameMetadata {
  participantHash: number;
  mediaTimestamp: number;
  sequence: number;
  endOfTurn?: boolean;
  cancelled?: boolean;
}

export function encodeAudioObject(metadata: AudioFrameMetadata, opusFrame: Uint8Array): Uint8Array {
  const header = new ArrayBuffer(AUDIO_OBJECT_HEADER_BYTES);
  const view = new DataView(header);
  view.setUint8(0, AUDIO_FORMAT_VERSION);
  view.setUint8(1, (metadata.endOfTurn ? 1 : 0) | (metadata.cancelled ? 2 : 0));
  view.setUint32(2, metadata.participantHash);
  view.setBigUint64(6, BigInt(metadata.mediaTimestamp));
  view.setUint32(14, metadata.sequence);
  view.setUint16(18, AUDIO_FRAME_DURATION_MS);
  view.setUint16(20, opusFrame.byteLength);
  const result = new Uint8Array(header.byteLength + opusFrame.byteLength);
  result.set(new Uint8Array(header));
  result.set(opusFrame, header.byteLength);
  return result;
}

export function decodeAudioObject(value: Uint8Array): {
  metadata: AudioFrameMetadata;
  opusFrame: Uint8Array;
} {
  if (value.byteLength < AUDIO_OBJECT_HEADER_BYTES) {
    throw new Error(
      `Audio object is shorter than the ${AUDIO_OBJECT_HEADER_BYTES}-byte v1 header.`,
    );
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const version = view.getUint8(0);
  if (version !== AUDIO_FORMAT_VERSION)
    throw new Error(`Unsupported audio format version '${version}'.`);
  const payloadLength = view.getUint16(20);
  if (value.byteLength !== AUDIO_OBJECT_HEADER_BYTES + payloadLength)
    throw new Error("Audio object payload length does not match its header.");
  const flags = view.getUint8(1);
  return {
    metadata: {
      participantHash: view.getUint32(2),
      mediaTimestamp: Number(view.getBigUint64(6)),
      sequence: view.getUint32(14),
      ...(flags & 1 ? { endOfTurn: true } : {}),
      ...(flags & 2 ? { cancelled: true } : {}),
    },
    opusFrame: value.slice(AUDIO_OBJECT_HEADER_BYTES),
  };
}
