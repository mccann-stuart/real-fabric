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
  // Performance optimization (⚡ Bolt): Write header fields directly into the output
  // Uint8Array buffer using a DataView, eliminating intermediate ArrayBuffer and
  // Uint8Array wrapper allocations and redundant byte copying on every 20ms frame.
  const totalLength = AUDIO_OBJECT_HEADER_BYTES + opusFrame.byteLength;
  const result = new Uint8Array(totalLength);
  const view = new DataView(result.buffer, result.byteOffset, AUDIO_OBJECT_HEADER_BYTES);
  view.setUint8(0, AUDIO_FORMAT_VERSION);
  view.setUint8(1, (metadata.endOfTurn ? 1 : 0) | (metadata.cancelled ? 2 : 0));
  view.setUint32(2, metadata.participantHash);
  // ⚡ Bolt Optimization: Write 64-bit big-endian media timestamp as dual uint32 words.
  // Eliminates BigInt object allocation and BigUint64 conversion overhead on 50Hz audio frame encode hot path.
  const ts = metadata.mediaTimestamp;
  view.setUint32(6, Math.floor(ts / 4_294_967_296));
  view.setUint32(10, ts >>> 0);
  view.setUint32(14, metadata.sequence);
  view.setUint16(18, AUDIO_FRAME_DURATION_MS);
  view.setUint16(20, opusFrame.byteLength);
  result.set(opusFrame, AUDIO_OBJECT_HEADER_BYTES);
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
  // ⚡ Bolt Optimization: Read 64-bit big-endian media timestamp as dual uint32 words.
  // Bypasses getBigUint64 and Number(BigInt) conversion overhead on incoming 50Hz audio frames.
  const metadata: AudioFrameMetadata = {
    participantHash: view.getUint32(2),
    mediaTimestamp: view.getUint32(6) * 4_294_967_296 + view.getUint32(10),
    sequence: view.getUint32(14),
  };
  if (flags & 1) metadata.endOfTurn = true;
  if (flags & 2) metadata.cancelled = true;
  return {
    metadata,
    // Performance optimization (⚡ Bolt): Use zero-copy subarray view instead of .slice()
    // to avoid allocating a new memory copy for every incoming 20ms audio frame.
    opusFrame: value.subarray(AUDIO_OBJECT_HEADER_BYTES),
  };
}
