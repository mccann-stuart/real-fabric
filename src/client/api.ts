import type {
  AiPipelineState,
  ApiError,
  CreateRoomResponse,
  JoinRoomResponse,
  PresenterConfiguration,
  RoomSnapshot,
} from "../shared/contracts";

export interface StoredSession {
  code: string;
  participantId: string;
  rejoinToken: string;
  displayName: string;
  /** H12: the reload path needs to know the token is still inside the window. */
  storedAt: number;
}

export interface HealthReport {
  ok: boolean;
  service: string;
  draft: string;
  /** §11.2: what the pre-flight HTTP/3 probe aims at. Null when none is set. */
  relayEndpoint: string | null;
  relayEndpointName: string | null;
  /** Gate 1 exit: whether a browser-to-relay trace has been recorded. */
  transportVerified: boolean;
  routingEnforcement: "enforced" | "cooperative";
  discovery: string;
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

export async function fetchHealth(): Promise<HealthReport> {
  return request<HealthReport>("/api/health");
}

export async function createRoom(displayName: string): Promise<CreateRoomResponse> {
  return post<CreateRoomResponse>("/api/rooms", { displayName });
}

export async function joinRoom(
  code: string,
  displayName: string,
  rejoinToken?: string,
): Promise<JoinRoomResponse> {
  return post<JoinRoomResponse>(`/api/rooms/${normaliseCode(code)}/join`, {
    displayName,
    ...(rejoinToken ? { rejoinToken } : {}),
  });
}

export async function fetchRoom(code: string): Promise<RoomSnapshot> {
  return request<RoomSnapshot>(`/api/rooms/${normaliseCode(code)}`);
}

export async function leaveRoom(session: StoredSession): Promise<RoomSnapshot> {
  return post<RoomSnapshot>(`/api/rooms/${session.code}/leave`, credential(session));
}

/**
 * FR1: a closed tab still has to start the 60-second rejoin window. `pagehide`
 * gives no time for a normal round trip, so this is fire-and-forget with
 * `keepalive`. Failure is acceptable — the participant then times out instead.
 */
export function signalLeaveOnUnload(session: StoredSession): void {
  void fetch(`/api/rooms/${session.code}/leave`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credential(session)),
    keepalive: true,
  }).catch(() => undefined);
}

export async function updateRouting(
  session: StoredSession,
  aiId: string,
  hearsMe: boolean,
  iHearIt: boolean,
): Promise<RoomSnapshot> {
  return post<RoomSnapshot>(`/api/rooms/${session.code}/routing`, {
    ...credential(session),
    aiId,
    hearsMe,
    iHearIt,
  });
}

export async function addAi(
  session: StoredSession,
  displayName: string,
  options: { address?: string; wakeName?: string; simulated: boolean },
): Promise<RoomSnapshot> {
  return post<RoomSnapshot>(`/api/rooms/${session.code}/ai`, {
    ...credential(session),
    displayName,
    ...(options.address ? { address: options.address } : {}),
    ...(options.wakeName ? { wakeName: options.wakeName } : {}),
    simulated: options.simulated,
  });
}

export async function removeAi(session: StoredSession, aiId: string): Promise<RoomSnapshot> {
  return send<RoomSnapshot>(`/api/rooms/${session.code}/ai`, "DELETE", {
    ...credential(session),
    aiId,
  });
}

export async function setAiPipeline(
  session: StoredSession,
  aiId: string,
  pipeline: AiPipelineState,
): Promise<RoomSnapshot> {
  return post<RoomSnapshot>(`/api/rooms/${session.code}/ai-pipeline`, {
    ...credential(session),
    aiId,
    pipeline,
  });
}

export async function requestFloor(
  session: StoredSession,
  aiId: string,
): Promise<{ granted: boolean; room: RoomSnapshot }> {
  return post<{ granted: boolean; room: RoomSnapshot }>(`/api/rooms/${session.code}/floor`, {
    ...credential(session),
    aiId,
    operation: "request",
  });
}

export async function releaseFloor(session: StoredSession, aiId: string): Promise<RoomSnapshot> {
  return post<RoomSnapshot>(`/api/rooms/${session.code}/floor`, {
    ...credential(session),
    aiId,
    operation: "release",
  });
}

export async function setAiToAi(
  session: StoredSession,
  operation: "enable" | "disable" | "reset",
): Promise<RoomSnapshot> {
  return post<RoomSnapshot>(`/api/rooms/${session.code}/ai-to-ai`, {
    ...credential(session),
    operation,
  });
}

export async function recordAiToAiTurn(
  session: StoredSession,
): Promise<{ allowed: boolean; room: RoomSnapshot }> {
  return post<{ allowed: boolean; room: RoomSnapshot }>(`/api/rooms/${session.code}/ai-to-ai`, {
    ...credential(session),
    operation: "turn",
  });
}

export async function configurePresenter(
  session: StoredSession,
  configuration: PresenterConfiguration,
): Promise<RoomSnapshot> {
  return post<RoomSnapshot>(`/api/rooms/${session.code}/presenter`, {
    ...credential(session),
    ...configuration,
  });
}

export async function markActive(session: StoredSession, targetId: string): Promise<void> {
  await send<void>(`/api/rooms/${session.code}/active`, "POST", {
    ...credential(session),
    targetId,
  });
}

/**
 * §8 link separation: the control-plane socket carries the participant token in
 * a query string, so this URL is a secret and never appears in telemetry or a
 * share link.
 */
export function roomEventsUrl(session: StoredSession): string {
  const url = new URL(`/api/rooms/${session.code}/events`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("participant", session.participantId);
  url.searchParams.set("token", session.rejoinToken);
  return url.toString();
}

export function storeSession(session: Omit<StoredSession, "storedAt">): StoredSession {
  const stored: StoredSession = { ...session, storedAt: Date.now() };
  sessionStorage.setItem(`real-fabric:${session.code}`, JSON.stringify(stored));
  return stored;
}

export function loadSession(code: string): StoredSession | null {
  const raw = sessionStorage.getItem(`real-fabric:${normaliseCode(code)}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.participantId || !parsed.rejoinToken) return null;
    return { ...parsed, storedAt: parsed.storedAt ?? Date.now() };
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

function credential(session: StoredSession): { participantId: string; rejoinToken: string } {
  return { participantId: session.participantId, rejoinToken: session.rejoinToken };
}

async function post<T>(input: string, body: unknown): Promise<T> {
  return send<T>(input, "POST", body);
}

async function send<T>(input: string, method: string, body: unknown): Promise<T> {
  return request<T>(input, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
