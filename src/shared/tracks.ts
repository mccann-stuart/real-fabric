/**
 * H2: one independent track per participant, human or AI, with no mixing at the
 * relay or the room service.
 *
 * Specification §6.2 requires relay-visible names to be opaque: no display
 * names, no role. A human and an AI are indistinguishable here by design, which
 * is the layering argument the demo makes out loud.
 */

export interface TrackAddress {
  namespace: string;
  name: string;
}

export type TrackKind = "audio" | "presence";

export function roomNamespace(opaqueRoomId: string): string {
  return `demo/${opaqueRoomId}`;
}

export function participantNamespace(opaqueRoomId: string, participantId: string): string {
  return `${roomNamespace(opaqueRoomId)}/${participantId}`;
}

export function audioTrack(opaqueRoomId: string, participantId: string): TrackAddress {
  return {
    namespace: participantNamespace(opaqueRoomId, participantId),
    name: `audio/${participantId}`,
  };
}

export function presenceTrack(opaqueRoomId: string, participantId: string): TrackAddress {
  return {
    namespace: participantNamespace(opaqueRoomId, participantId),
    name: `presence/${participantId}`,
  };
}

export function trackKey(track: TrackAddress): string {
  return `${track.namespace}/${track.name}`;
}

export function parseTrackName(name: string): { kind: TrackKind; participantId: string } | null {
  // ⚡ Bolt Optimization: Use fast prefix checking and slicing instead of regex
  // to eliminate RegExp object instantiation and match array allocations on track validation paths.
  if (name.startsWith("audio/")) {
    const participantId = name.slice(6);
    return participantId ? { kind: "audio", participantId } : null;
  }
  if (name.startsWith("presence/")) {
    const participantId = name.slice(9);
    return participantId ? { kind: "presence", participantId } : null;
  }
  return null;
}

/**
 * Every participant publishes exactly one audio track and subscribes to the
 * other n-1. This is the fan-out claim in §4.3, computed rather than asserted.
 */
export interface FanOut {
  publishedTracks: number;
  subscribedTracks: number;
}

export function fanOut(subscribedParticipantIds: readonly string[], publishing: boolean): FanOut {
  return {
    publishedTracks: publishing ? 1 : 0,
    subscribedTracks: subscribedParticipantIds.length,
  };
}
