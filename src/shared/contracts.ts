export const MOQT_DRAFT = "20" as const;
export const REJOIN_WINDOW_MS = 60_000;
export const ROOM_LIFETIME_MS = 20 * 60_000;

export type ParticipantRole = "human" | "ai";
export type ParticipantState = "connected" | "reconnecting" | "left";
export type TransportAvailability = "available" | "draft_unavailable" | "relay_unavailable";

export interface Participant {
  id: string;
  displayName: string;
  role: ParticipantRole;
  state: ParticipantState;
  joinedAt: number;
  reconnectUntil: number | null;
}

export interface RoutingPreference {
  humanId: string;
  aiId: string;
  hearsMe: boolean;
  iHearIt: boolean;
  enforcement: "enforced" | "cooperative";
  updatedAt: number;
}

export interface RoomSnapshot {
  code: string;
  createdAt: number;
  expiresAt: number;
  participants: Participant[];
  routing: RoutingPreference[];
  transport: {
    availability: TransportAvailability;
    draft: typeof MOQT_DRAFT;
    endpoint: string;
    reason: string;
  };
}

export interface CreateRoomResponse {
  room: RoomSnapshot;
  participant: Participant;
  rejoinToken: string;
  correlationId: string;
}

export interface JoinRoomResponse extends CreateRoomResponse {}

export interface ApiError {
  error: {
    code: string;
    message: string;
    correlationId: string;
  };
}

export type RoomEvent =
  | { type: "snapshot"; room: RoomSnapshot; at: number }
  | { type: "participant_changed"; participantId: string; state: ParticipantState; at: number }
  | { type: "routing_changed"; humanId: string; aiId: string; at: number }
  | { type: "room_expired"; at: number };
