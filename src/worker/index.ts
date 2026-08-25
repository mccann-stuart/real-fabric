import type {
  AiPipelineState,
  ApiError,
  CreateRoomResponse,
  JoinRoomResponse,
  RoomSnapshot,
} from "../shared/contracts";
import { MAX_SIMULATED_PARTICIPANTS } from "../shared/contracts";
import { configFlag, configValue } from "./env";
import type { ParticipantCredential } from "./room";
import { Room } from "./room";
import { decodeRoomError } from "./roomError";
import {
  HttpError,
  optionalString,
  readJsonObject,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
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
      // A refusal from the room service carries its own status, so an invalid
      // credential does not read as a server fault (H14 applies to the API too).
      const roomFailure = decodeRoomError(error);
      const status = roomFailure?.status ?? (error instanceof HttpError ? error.status : 500);
      const code =
        roomFailure?.code ?? (error instanceof HttpError ? error.code : "internal_error");
      const message =
        roomFailure?.message ??
        (error instanceof HttpError
          ? error.message
          : "The request could not be completed. No room state was changed after the failure.");
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
    // Gate 1 facts, read from configuration rather than assumed. The client
    // renders the specific §10 failure from these, never a generic error.
    return json({
      ok: true,
      service: "real-fabric",
      draft: env.MOQT_DRAFT,
      transportVerified: configFlag(env.MOQT_TRANSPORT_VERIFIED),
      routingEnforcement:
        configValue(env.MOQ_ROUTING_ENFORCEMENT) === "enforced" ? "enforced" : "cooperative",
      discovery: configValue(env.MOQ_DISCOVERY),
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
    return json<CreateRoomResponse>(
      { ...joined, relayCredential: mintRelayCredential(env), correlationId },
      201,
    );
  }

  const match = url.pathname.match(
    /^\/api\/rooms\/([A-Z0-9]{20})(?:\/(join|leave|routing|events|ai|ai-pipeline|floor|ai-to-ai|presenter|active))?$/,
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
      return json<JoinRoomResponse>({
        ...joined,
        relayCredential: mintRelayCredential(env),
        correlationId,
      });
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

    if (request.method === "POST" && action === "ai") {
      const body = await readJsonObject(request);
      const credential = readCredential(body);
      const displayName = requiredString(body, "displayName", 80);
      const address = optionalString(body, "address", 80);
      const wakeName = optionalString(body, "wakeName", 80);
      const simulated = requiredBoolean(body, "simulated");
      const room = await stub.addAi(credential, displayName, {
        ...(address ? { address } : {}),
        ...(wakeName ? { wakeName } : {}),
        simulated,
      });
      logRoomEvent("ai_added", correlationId, code, credential.participantId);
      return json(room, 201);
    }

    if (request.method === "DELETE" && action === "ai") {
      const body = await readJsonObject(request);
      const credential = readCredential(body);
      const aiId = requiredString(body, "aiId", 64);
      const room = await stub.removeAi(credential, aiId);
      logRoomEvent("ai_removed", correlationId, code, credential.participantId);
      return json(room);
    }

    if (request.method === "POST" && action === "ai-pipeline") {
      const body = await readJsonObject(request);
      const credential = readCredential(body);
      const aiId = requiredString(body, "aiId", 64);
      const pipeline = requiredEnum<AiPipelineState>(body, "pipeline", [
        "listening",
        "thinking",
        "speaking",
        "interrupted",
        "unavailable",
      ]);
      const room = await stub.setAiPipeline(credential, aiId, pipeline);
      return json(room);
    }

    if (request.method === "POST" && action === "floor") {
      const body = await readJsonObject(request);
      const credential = readCredential(body);
      const aiId = requiredString(body, "aiId", 64);
      const operation = requiredEnum(body, "operation", ["request", "release"] as const);
      if (operation === "release") return json(await stub.releaseFloor(credential, aiId));
      const result = await stub.requestFloor(credential, aiId);
      logRoomEvent("floor_requested", correlationId, code, credential.participantId);
      return json(result);
    }

    if (request.method === "POST" && action === "ai-to-ai") {
      const body = await readJsonObject(request);
      const credential = readCredential(body);
      const operation = requiredEnum(body, "operation", [
        "enable",
        "disable",
        "turn",
        "reset",
      ] as const);
      if (operation === "turn") {
        const result = await stub.recordAiToAiTurn(credential);
        logRoomEvent("ai_to_ai_turn", correlationId, code, credential.participantId);
        return json(result);
      }
      if (operation === "reset") {
        await stub.resetAiToAiTurns(credential);
        const room = await stub.getSnapshot();
        if (!room) throw roomNotFound();
        return json(room);
      }
      const room = await stub.setAiToAi(credential, operation === "enable");
      logRoomEvent("ai_to_ai_changed", correlationId, code, credential.participantId);
      return json(room);
    }

    if (request.method === "POST" && action === "presenter") {
      const body = await readJsonObject(request);
      const credential = readCredential(body);
      const room = await stub.configurePresenter(credential, {
        simulatedHumans: requiredInteger(body, "simulatedHumans", 0, MAX_SIMULATED_PARTICIPANTS),
        simulatedAis: requiredInteger(body, "simulatedAis", 0, MAX_SIMULATED_PARTICIPANTS),
        scriptedResponses: requiredBoolean(body, "scriptedResponses"),
      });
      logRoomEvent("presenter_configured", correlationId, code, credential.participantId);
      return json(room);
    }

    if (request.method === "POST" && action === "active") {
      const body = await readJsonObject(request);
      const credential = readCredential(body);
      const participantId = requiredString(body, "targetId", 64);
      await stub.markActive(credential, participantId);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
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

/**
 * §8: short-lived, least-privilege relay credentials are minted server-side.
 *
 * No relay serves the pinned draft yet (§2.1), so there is nothing to mint
 * against and this returns null. Returning null rather than a placeholder is
 * the point: the client reports "no draft-20 relay endpoint" instead of
 * attempting a connection that would have to downgrade to succeed.
 */
function mintRelayCredential(env: Env): string | null {
  if (!configFlag(env.MOQT_TRANSPORT_VERIFIED)) return null;
  throw new HttpError(
    501,
    "relay_credential_unimplemented",
    "Transport is marked verified but relay credential minting is not implemented. Gate 1 must record the credential model before this path is enabled.",
  );
}

function readCredential(body: Record<string, unknown>): ParticipantCredential {
  return {
    participantId: requiredString(body, "participantId", 64),
    rejoinToken: requiredString(body, "rejoinToken", 128),
  };
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
