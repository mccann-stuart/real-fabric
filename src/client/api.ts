import type {
  ApiError,
  CreateRoomResponse,
  JoinRoomResponse,
  RoomSnapshot,
} from "../shared/contracts";

export interface StoredSession {
  code: string;
  participantId: string;
  rejoinToken: string;
  displayName: string;
}

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly correlationId: string,
  ) {
    super(message);
  }
}

export async function createRoom(displayName: string): Promise<CreateRoomResponse> {
  return request<CreateRoomResponse>("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
}

export async function joinRoom(
  code: string,
  displayName: string,
  rejoinToken?: string,
): Promise<JoinRoomResponse> {
  return request<JoinRoomResponse>(`/api/rooms/${normaliseCode(code)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName, ...(rejoinToken ? { rejoinToken } : {}) }),
  });
}

export async function fetchRoom(code: string): Promise<RoomSnapshot> {
  return request<RoomSnapshot>(`/api/rooms/${normaliseCode(code)}`);
}

export async function leaveRoom(session: StoredSession): Promise<RoomSnapshot> {
  return request<RoomSnapshot>(`/api/rooms/${session.code}/leave`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      participantId: session.participantId,
      rejoinToken: session.rejoinToken,
    }),
  });
}

export async function updateRouting(
  session: StoredSession,
  aiId: string,
  hearsMe: boolean,
  iHearIt: boolean,
): Promise<RoomSnapshot> {
  return request<RoomSnapshot>(`/api/rooms/${session.code}/routing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      participantId: session.participantId,
      rejoinToken: session.rejoinToken,
      aiId,
      hearsMe,
      iHearIt,
    }),
  });
}

export function storeSession(session: StoredSession): void {
  sessionStorage.setItem(`real-fabric:${session.code}`, JSON.stringify(session));
}

export function loadSession(code: string): StoredSession | null {
  const raw = sessionStorage.getItem(`real-fabric:${normaliseCode(code)}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function clearSession(code: string): void {
  sessionStorage.removeItem(`real-fabric:${normaliseCode(code)}`);
}

export function normaliseCode(code: string): string {
  return code
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 20);
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { ...init?.headers, "x-correlation-id": crypto.randomUUID() },
  });
  if (!response.ok) {
    let problem: ApiError | undefined;
    try {
      problem = (await response.json()) as ApiError;
    } catch {
      throw new ApiClientError(
        "http_error",
        `Request failed with HTTP ${response.status}.`,
        "not-exposed",
      );
    }
    throw new ApiClientError(
      problem.error.code,
      problem.error.message,
      problem.error.correlationId,
    );
  }
  return (await response.json()) as T;
}
