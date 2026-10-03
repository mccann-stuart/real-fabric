import type { RoomSnapshot } from "../../shared/contracts";
import { joinRoom, normaliseCode, type StoredSession, storeSession } from "../api";
import { rememberRelayCredential } from "../session/RoomSession";

interface OpenedRoom {
  room: RoomSnapshot;
  session: StoredSession;
  reclaimed: boolean;
}

let pendingEntry: { code: string; participantId: string; room: RoomSnapshot } | null = null;

/** Carry the entry response across the in-app navigation without persisting it. */
export function stageRoomEntry(session: StoredSession, room: RoomSnapshot): void {
  pendingEntry = {
    code: normaliseCode(session.code),
    participantId: session.participantId,
    room,
  };
}

export async function openRoomEntry(stored: StoredSession): Promise<OpenedRoom> {
  const entry = pendingEntry;
  pendingEntry = null;
  if (entry?.code === normaliseCode(stored.code) && entry.participantId === stored.participantId) {
    return { room: entry.room, session: stored, reclaimed: false };
  }

  // Only a later mount presents the token to the room service. A real reload
  // has no in-memory entry response, so it must go through the 60-second reclaim.
  const joined = await joinRoom(stored.code, stored.displayName, stored.rejoinToken);
  const refreshed = storeSession({
    code: joined.room.code,
    participantId: joined.participant.id,
    rejoinToken: joined.rejoinToken,
    displayName: stored.displayName,
  });
  rememberRelayCredential(joined.participant.id, joined.relayCredential);
  return {
    room: joined.room,
    session: refreshed,
    reclaimed: joined.participant.id === stored.participantId,
  };
}
