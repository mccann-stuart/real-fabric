import type { FailureCode } from "./failures";

/**
 * §11.2: the drafts this build knows how to talk about. Which one it can
 * actually frame is decided by `MoqTransportAdapter` alone — this list exists so
 * configuration, the room service and the inspector can name a draft without
 * importing the adapter's wire constants.
 */
export const MOQT_DRAFTS = ["14", "16", "18", "20"] as const;
export type MoqDraft = (typeof MOQT_DRAFTS)[number];

/**
 * The Gate 1 target. Draft 20 has no deployed relay endpoint (§2.1), so the
 * release plan pins the milestone at the operational Cloudflare draft-16
 * endpoint instead. Moving to 20 is a configuration change and an adapter
 * registry entry, not a room, UI or audio change.
 */
export const PINNED_MOQT_DRAFT: MoqDraft = "16";

export function asMoqDraft(value: string): MoqDraft | null {
  return (MOQT_DRAFTS as readonly string[]).includes(value) ? (value as MoqDraft) : null;
}

export const REJOIN_WINDOW_MS = 60_000;
export const ROOM_LIFETIME_MS = 20 * 60_000;
/** FR1: empty rooms expire well before the hard stop. */
export const EMPTY_ROOM_EXPIRY_MS = 15 * 60_000;
/** FR4: hard cap on consecutive AI-to-AI turns once a presenter enables them. */
export const AI_TO_AI_TURN_CAP = 6;
/** FR8: a routing change must take effect within this budget. */
export const ROUTING_CHANGE_BUDGET_MS = 500;
/** H6: audible stop after human onset. */
export const BARGE_IN_BUDGET_MS = 300;
/** H11: presenter simulation is configurable, not a fixed cast. */
export const MAX_SIMULATED_PARTICIPANTS = 24;

export type ParticipantRole = "human" | "ai";
export type ParticipantState = "connected" | "reconnecting" | "left";

/** Stored AI pipeline state. Viewer-specific labels are derived, not stored. */
export type AiPipelineState = "listening" | "thinking" | "speaking" | "interrupted" | "unavailable";

export type TransportAvailability = "available" | "draft_unavailable" | "relay_unavailable";

/** FR7: discovery is advisory, and the inspector must say which mechanism ran. */
export type DiscoveryMechanism = "subscribe_namespace" | "control_channel" | "unknown";

/** FR8: the strong form is relay-enforced. Anything else must say so. */
export type RoutingEnforcement = "enforced" | "cooperative";

export interface Participant {
  id: string;
  displayName: string;
  role: ParticipantRole;
  state: ParticipantState;
  joinedAt: number;
  reconnectUntil: number | null;
  /** H11: presenter simulation must be unmistakable everywhere it appears. */
  simulated: boolean;
  /** H5: an AI's own address. Null for humans. */
  address: string | null;
  /** H5: spoken wake name, where the addressing mechanism is a wake name. */
  wakeName: string | null;
  /** Null for humans. */
  pipeline: AiPipelineState | null;
  /** Last time this participant published audio, for grid ordering and the ladder. */
  lastActiveAt: number;
}

export interface RoutingPreference {
  humanId: string;
  aiId: string;
  /** Inbound: does this AI subscribe to this human's track. Default off (§8 consent). */
  hearsMe: boolean;
  /** Outbound: does this human subscribe to this AI's track. Purely local. */
  iHearIt: boolean;
  enforcement: RoutingEnforcement;
  updatedAt: number;
}

/** FR4: AI-to-AI is off by default and capped when a presenter enables it. */
export interface AiToAiState {
  enabled: boolean;
  consecutiveTurns: number;
  turnCap: number;
  /** True once the cap stopped an exchange, so the UI can name the reason. */
  cappedAt: number | null;
}

/** FR4: an AI never begins publishing while another AI is publishing. */
export interface FloorState {
  holderId: string | null;
  heldSince: number | null;
  /** AI ids waiting, in arrival order. Each shows Thinking. */
  queue: string[];
}

export interface TransportStatus {
  availability: TransportAvailability;
  draft: MoqDraft;
  endpoint: string;
  /** Operator-facing relay name for the inspector and the Gate 1 record. */
  endpointName: string;
  /**
   * H1 and Gate 1 exit: whether a browser-to-relay trace has been recorded for
   * this endpoint. Deliberately separate from `availability`. An endpoint being
   * configured is reason enough to attempt a real session; only a recorded
   * trace is reason enough to claim one works.
   */
  traceVerified: boolean;
  /** §10 row in effect when availability is not `available`. */
  failure: FailureCode | null;
  reason: string;
  discovery: DiscoveryMechanism;
  routingEnforcement: RoutingEnforcement;
}

export interface PresenterConfiguration {
  /** H11: how many labelled simulated participants the presenter asked for. */
  simulatedHumans: number;
  simulatedAis: number;
  /** FR4: scripted responses, clearly labelled, when no live pipeline exists. */
  scriptedResponses: boolean;
}

export interface RoomSnapshot {
  code: string;
  createdAt: number;
  expiresAt: number;
  participants: Participant[];
  routing: RoutingPreference[];
  transport: TransportStatus;
  aiToAi: AiToAiState;
  floor: FloorState;
  presenter: PresenterConfiguration;
  /** H8: any composition with at least one human is valid. */
  composition: { humans: number; ais: number; valid: boolean };
}

export interface CreateRoomResponse {
  room: RoomSnapshot;
  participant: Participant;
  rejoinToken: string;
  /**
   * §8 link separation: the provisioned relay credential is returned only at
   * create/join, never in the room snapshot or shareable room URL. Null while
   * either the endpoint or its credential is unconfigured — the client then
   * reports the specific §10 failure rather than attempting anonymously.
   */
  relayCredential: string | null;
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
  | { type: "ai_pipeline_changed"; aiId: string; pipeline: AiPipelineState; at: number }
  | { type: "floor_changed"; holderId: string | null; queue: string[]; at: number }
  | { type: "ai_to_ai_changed"; enabled: boolean; consecutiveTurns: number; at: number }
  | { type: "room_expired"; at: number };

/**
 * H9: the AI card label a given human sees. `Partial context` is visible to
 * everyone; `Not listening to you` is specific to the viewer.
 */
export type AiDisplayActivity =
  | "Listening"
  | "Thinking"
  | "Speaking"
  | "Interrupted"
  | "Not listening to you"
  | "Partial context"
  | "Unavailable";

export function aiDisplayActivity(
  ai: Participant,
  routing: readonly RoutingPreference[],
  viewerId: string,
  connectedHumanIds: readonly string[],
): AiDisplayActivity {
  if (ai.pipeline === "unavailable" || ai.state === "left") return "Unavailable";

  // Performance optimization (⚡ Bolt): Single linear pass over routing array instead of
  // O(|connectedHumanIds| * |routing|) nested iterations with .find() and .every() + .some().
  let viewerHearsMe: boolean | undefined;
  const hearingHumans = new Set<string>();

  for (let index = 0; index < routing.length; index += 1) {
    const row = routing[index];
    if (row && row.aiId === ai.id) {
      if (row.humanId === viewerId) {
        viewerHearsMe = row.hearsMe;
      }
      if (row.hearsMe) {
        hearingHumans.add(row.humanId);
      }
    }
  }

  if (viewerHearsMe === false) return "Not listening to you";

  // Visible to everyone: this AI is answering on an incomplete picture.
  for (let index = 0; index < connectedHumanIds.length; index += 1) {
    const humanId = connectedHumanIds[index];
    if (humanId && !hearingHumans.has(humanId)) {
      return "Partial context";
    }
  }

  switch (ai.pipeline) {
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
    case "interrupted":
      return "Interrupted";
    default:
      return "Listening";
  }
}

/** H8: at least one human, any number of AIs, no upper bound anywhere. */
export function evaluateComposition(participants: readonly Participant[]): {
  humans: number;
  ais: number;
  valid: boolean;
} {
  // Performance optimization (⚡ Bolt): Single pass over participants without array allocations
  let humans = 0;
  let ais = 0;
  for (let index = 0; index < participants.length; index += 1) {
    const participant = participants[index];
    if (participant && participant.state !== "left") {
      if (participant.role === "human") {
        humans += 1;
      } else if (participant.role === "ai") {
        ais += 1;
      }
    }
  }
  return { humans, ais, valid: humans >= 1 };
}
