import type {
  ApiError,
  CreateRoomResponse,
  JoinRoomResponse,
  RoomSnapshot,
} from "../shared/contracts";
import { Room } from "./room";
import {
  HttpError,
  optionalString,
  readJsonObject,
  requiredBoolean,
  requiredString,
} from "./validation";

export { Room };

type RoomNamespace = DurableObjectNamespace<Room>;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const response = await route(request, env, correlationId);
      ctx.waitUntil(
        Promise.resolve().then(() =>
          console.log(
            JSON.stringify({
              event: "request_complete",
              correlationId,
              method: request.method,
              route: normalisedRoute(new URL(request.url).pathname),
              status: response.status,
              durationMs: Date.now() - startedAt,
            }),
          ),
        ),
      );
      // A WebSocket upgrade response owns a live socket and cannot be cloned to add headers.
      if (response.status === 101) return response;
      return withSecurityHeaders(response, correlationId);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      const message =
        error instanceof HttpError
          ? error.message
          : "The request could not be completed. No room state was changed after the failure.";
      console.error(JSON.stringify({ event: "request_failed", correlationId, code, status }));
      return withSecurityHeaders(
        json<ApiError>({ error: { code, message, correlationId } }, status),
        correlationId,
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, correlationId: string): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({
      ok: true,
      service: "real-fabric",
      draft: env.MOQT_DRAFT,
      transportVerified: false,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readJsonObject(request);
    const displayName = requiredString(body, "displayName", 80);
    await enforceCreationRateLimit(request, env);
    const code = roomCode();
    const stub = roomStub(env, code);
    await stub.initialise(code, Date.now());
    const joined = await stub.join(displayName);
    logRoomEvent("room_created", correlationId, code, joined.participant.id);
    return json<CreateRoomResponse>({ ...joined, correlationId }, 201);
  }

  const match = url.pathname.match(
    /^\/api\/rooms\/([A-Z0-9]{20})(?:\/(join|leave|routing|events))?$/,
  );
  if (match) {
    const code = match[1];
    const action = match[2];
    if (!code) throw new HttpError(404, "room_not_found", "The room code is invalid.");
    const stub = roomStub(env, code);

    if (request.method === "GET" && !action) {
      const room = await stub.getSnapshot();
      if (!room) throw roomNotFound();
      return json<RoomSnapshot>(room);
    }

    if (request.method === "POST" && action === "join") {
      if (!(await stub.getSnapshot())) throw roomNotFound();
      const body = await readJsonObject(request);
      const displayName = requiredString(body, "displayName", 80);
      const rejoinToken = optionalString(body, "rejoinToken", 128);
      const joined = await stub.join(displayName, rejoinToken);
      logRoomEvent("participant_joined", correlationId, code, joined.participant.id);
      return json<JoinRoomResponse>({ ...joined, correlationId });
    }

    if (request.method === "POST" && action === "leave") {
      const body = await readJsonObject(request);
      const participantId = requiredString(body, "participantId", 64);
      const rejoinToken = requiredString(body, "rejoinToken", 128);
      const room = await stub.leave(participantId, rejoinToken);
      logRoomEvent("participant_left", correlationId, code, participantId);
      return json(room);
    }

    if (request.method === "POST" && action === "routing") {
      const body = await readJsonObject(request);
      const participantId = requiredString(body, "participantId", 64);
      const rejoinToken = requiredString(body, "rejoinToken", 128);
      const aiId = requiredString(body, "aiId", 64);
      const hearsMe = requiredBoolean(body, "hearsMe");
      const iHearIt = requiredBoolean(body, "iHearIt");
      const room = await stub.updateRouting(participantId, rejoinToken, aiId, hearsMe, iHearIt);
      logRoomEvent("routing_changed", correlationId, code, participantId);
      return json(room);
    }

    if (request.method === "GET" && action === "events") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        throw new HttpError(
          426,
          "websocket_required",
          "This control-plane endpoint requires WebSocket upgrade.",
        );
      }
      const participantId = url.searchParams.get("participant") ?? "";
      const rejoinToken = url.searchParams.get("token") ?? "";
      if (!participantId || !rejoinToken) {
        throw new HttpError(
          401,
          "participant_auth_required",
          "Participant control credentials are required.",
        );
      }
      return stub.fetch(request);
    }
  }

  if (url.pathname.startsWith("/api/"))
    throw new HttpError(404, "not_found", "API route not found.");
  return env.ASSETS.fetch(request);
}

function roomStub(env: Env, code: string): DurableObjectStub<Room> {
  if (!env.ROOMS)
    throw new HttpError(
      503,
      "room_service_unavailable",
      "The room service binding is unavailable.",
    );
  return (env.ROOMS as RoomNamespace).getByName(code);
}

function roomNotFound(): HttpError {
  return new HttpError(404, "room_not_found", "The room does not exist or has expired.");
}

async function enforceCreationRateLimit(request: Request, env: Env): Promise<void> {
  const address = request.headers.get("cf-connecting-ip") ?? "local";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  const key = Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const allowed = await roomStub(env, `rate-${key}`).checkCreationRateLimit(Date.now());
  if (!allowed)
    throw new HttpError(
      429,
      "room_creation_limited",
      "Too many rooms were created recently. Try again later.",
    );
}

function roomCode(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase();
}

function json<T>(value: T, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function withSecurityHeaders(response: Response, correlationId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(self)");
  headers.set(
    "content-security-policy",
    "default-src 'self'; connect-src 'self' https: wss:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  headers.set("x-correlation-id", correlationId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalisedRoute(pathname: string): string {
  return pathname.replace(/[A-Z0-9]{20}/g, ":room");
}

function logRoomEvent(
  event: string,
  correlationId: string,
  roomCodeValue: string,
  participantId: string,
): void {
  console.log(JSON.stringify({ event, correlationId, roomId: roomCodeValue, participantId }));
}
