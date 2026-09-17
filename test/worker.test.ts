import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CreateRoomResponse, RoomSnapshot } from "../src/shared/contracts";
import worker from "../src/worker/index";

describe("Real Fabric Worker", () => {
  it("handles unexpected generic errors with HTTP 500 internal_error, correlation ID, and security headers", async () => {
    const customCorrelationId = "test-correlation-id-12345";
    const mockEnv = new Proxy(env, {
      get(target, prop, receiver) {
        if (prop === "ROOMS") {
          throw new Error("Unexpected database explosion");
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const request = new Request("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": customCorrelationId,
      },
      body: JSON.stringify({ displayName: "Tester" }),
    });
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await worker.fetch(request, mockEnv, ctx);
    expect(response.status).toBe(500);
    expect(response.headers.get("x-correlation-id")).toBe(customCorrelationId);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");

    const body = (await response.json()) as {
      error: { code: string; message: string; correlationId: string };
    };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe(
      "The request could not be completed. No room state was changed after the failure.",
    );
    expect(body.error.correlationId).toBe(customCorrelationId);
  });

  it("returns 503 when the room service binding is missing", async () => {
    const request = new Request("https://real-fabric.test/api/rooms/UNKNOWNROOMCODE12345");
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await worker.fetch(
      request,
      {
        ...env,
        ROOMS: undefined as unknown as DurableObjectNamespace<import("../src/worker/room").Room>,
      } as Env,
      ctx,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("room_service_unavailable");
    expect(body.error.message).toBe("The room service binding is unavailable.");
  });

  it("returns 404 for unknown API routes", async () => {
    const response = await SELF.fetch("https://real-fabric.test/api/non-existent-endpoint");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toBe("API route not found.");
  });

  it("returns 426 when calling events endpoint without WebSocket upgrade header", async () => {
    const code = "ROOMCODE123456789012";
    const response = await SELF.fetch(`https://real-fabric.test/api/rooms/${code}/events`);
    expect(response.status).toBe(426);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("websocket_required");
    expect(body.error.message).toBe("This control-plane endpoint requires WebSocket upgrade.");
  });
  it("reports the room service without claiming transport verification", async () => {
    const response = await SELF.fetch("https://real-fabric.test/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "real-fabric",
      draft: "16",
      relayEndpoint: "https://draft-16.example.invalid",
      relayEndpointName: "draft-16.example.invalid",
      relayCredentialConfigured: true,
      relayCredentialStatus: "available",
      // Gate 1 has not run. Naming the endpoint is not claiming it works.
      transportVerified: false,
      routingEnforcement: "cooperative",
      discovery: "unknown",
    });
  });

  it("handles empty or invalid relay endpoints in endpointName helper", async () => {
    const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

    // Test with empty MOQ_RELAY_URL
    const resEmpty = await worker.fetch(
      new Request("https://real-fabric.test/api/health"),
      { ...env, MOQ_RELAY_URL: "" as unknown as typeof env.MOQ_RELAY_URL },
      ctx,
    );
    expect(resEmpty.status).toBe(200);
    const jsonEmpty = (await resEmpty.json()) as Record<string, unknown>;
    expect(jsonEmpty.relayEndpoint).toBeNull();
    expect(jsonEmpty.relayEndpointName).toBeNull();

    // Test with invalid MOQ_RELAY_URL URL string
    const resInvalid = await worker.fetch(
      new Request("https://real-fabric.test/api/health"),
      { ...env, MOQ_RELAY_URL: "not-a-valid-url" as unknown as typeof env.MOQ_RELAY_URL },
      ctx,
    );
    expect(resInvalid.status).toBe(200);
    const jsonInvalid = (await resInvalid.json()) as Record<string, unknown>;
    expect(jsonInvalid.relayEndpoint).toBe("not-a-valid-url");
    expect(jsonInvalid.relayEndpointName).toBeNull();
  });

  it("creates a non-guessable room and rejoins the same participant", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.44" },
      body: JSON.stringify({ displayName: "Ada" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as CreateRoomResponse;
    expect(created.room.code).toMatch(/^[A-Z0-9]{20}$/);
    // §11.2: an endpoint is configured, so a live session is attempted...
    expect(created.room.transport.availability).toBe("available");
    // ...and separately, no Gate 1 trace has been recorded, so nothing claims
    // that transport works.
    expect(created.room.transport.traceVerified).toBe(false);
    expect(created.participant.displayName).toBe("Ada");

    const leftResponse = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/leave`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId: created.participant.id,
          rejoinToken: created.rejoinToken,
        }),
      },
    );
    expect(leftResponse.status).toBe(200);

    const rejoinedResponse = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Ada Lovelace", rejoinToken: created.rejoinToken }),
      },
    );
    const rejoined = (await rejoinedResponse.json()) as CreateRoomResponse;
    expect(rejoined.participant.id).toBe(created.participant.id);
    expect(rejoined.participant.displayName).toBe("Ada Lovelace");
    expect(rejoined.room.participants).toHaveLength(1);
  });

  it("rate-limits room creation attempts before parsing their bodies", async () => {
    const headers = {
      "content-type": "application/json",
      "cf-connecting-ip": "198.51.100.250",
    };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const invalid = await SELF.fetch("https://real-fabric.test/api/rooms", {
        method: "POST",
        headers,
        body: "{",
      });
      expect(invalid.status).toBe(400);
    }

    const limited = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers,
      body: JSON.stringify({ displayName: "Ada" }),
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: "room_creation_limited" },
    });
  });

  it("rate-limits room join attempts per IP", async () => {
    const createRes = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
      body: JSON.stringify({ displayName: "Host" }),
    });
    const created = (await createRes.json()) as CreateRoomResponse;

    const headers = {
      "content-type": "application/json",
      "cf-connecting-ip": "198.51.100.251",
    };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await SELF.fetch(`https://real-fabric.test/api/rooms/${created.room.code}/join`, {
        method: "POST",
        headers,
        body: JSON.stringify({ displayName: `Guest ${attempt}` }),
      });
      expect(res.status).toBe(200);
    }

    const limited = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/join`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ displayName: "Guest 21" }),
      },
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: "room_join_limited" },
    });
  });

  it("does not put participant credentials in a shareable room snapshot", async () => {
    const response = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.45" },
      body: JSON.stringify({ displayName: "Grace" }),
    });
    const created = (await response.json()) as CreateRoomResponse;
    const snapshot = await SELF.fetch(`https://real-fabric.test/api/rooms/${created.room.code}`);
    const serialised = JSON.stringify(await snapshot.json());
    expect(serialised).not.toContain(created.rejoinToken);
    expect(serialised).not.toContain("rejoinToken");
  });

  it("returns a specific not-found response for an unknown room and does not initialize SQLite state (SEC-11)", async () => {
    const code = "UNKNOWNROOMCODE12345";
    const response = await SELF.fetch(`https://real-fabric.test/api/rooms/${code}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: {
        code: "room_not_found",
        message: "The room does not exist or has expired.",
      },
    });

    const rooms = env.ROOMS;
    if (!rooms) throw new Error("The ROOMS binding is required for SEC-11 test.");
    const stub = rooms.getByName(code);

    await runInDurableObject(stub, async (_instance, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('room_meta', 'participants')",
        )
        .toArray();
      expect(tables).toHaveLength(0);
    });
  });

  it("handles unparseable relay endpoint URLs gracefully in Room.transport.endpointName", async () => {
    const code = "UNPARSEABLETEST00001";
    const rooms = env.ROOMS;
    if (!rooms) throw new Error("The ROOMS binding is required.");
    const stub = rooms.getByName(code);

    await runInDurableObject(stub, async (instance, _state) => {
      // Temporarily set an unparseable relay URL on the instance environment
      (instance as unknown as { env: Record<string, string> }).env.MOQ_RELAY_URL =
        "http://[invalid-host";
      const snapshot = await instance.initialise(code, Date.now());
      expect(snapshot.transport.endpointName).toBe("an unparseable endpoint");
    });
  });

  it("uses WebSockets for authenticated control messages only", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.46" },
      body: JSON.stringify({ displayName: "Katherine" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;
    const addedAiResponse = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/ai`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId: created.participant.id,
          rejoinToken: created.rejoinToken,
          displayName: "Atlas",
          simulated: true,
        }),
      },
    );
    expect(addedAiResponse.status).toBe(201);
    const joinedResponse = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.246" },
        body: JSON.stringify({ displayName: "Grace" }),
      },
    );
    expect(joinedResponse.status).toBe(200);
    const joined = (await joinedResponse.json()) as CreateRoomResponse;
    const response = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );

    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();

    socket?.send(
      JSON.stringify({
        type: "auth",
        participantId: created.participant.id,
        token: created.rejoinToken,
      }),
    );

    const snapshot = await nextMessage(socket as WebSocket);
    const snapshotEvent = JSON.parse(String(snapshot.data)) as {
      type: string;
      room: RoomSnapshot;
    };
    expect(snapshotEvent.type).toBe("snapshot");
    expect(snapshotEvent.room.routing).toHaveLength(1);
    expect(snapshotEvent.room.routing[0]?.humanId).toBe(created.participant.id);
    expect(snapshotEvent.room.routing.some((row) => row.humanId === joined.participant.id)).toBe(
      false,
    );

    socket?.send("ping");
    const pong = await nextMessage(socket as WebSocket);
    expect(pong.data).toBe("pong");
    socket?.close(1000, "test complete");
  });

  it("closes WebSocket connections that send an invalid participant token", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.47" },
      body: JSON.stringify({ displayName: "Dorothy" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;

    const response = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    socket?.accept();

    const closed = nextClose(socket as WebSocket);
    socket?.send(
      JSON.stringify({
        type: "auth",
        participantId: created.participant.id,
        token: "invalid-token",
      }),
    );

    const closeEvent = await closed;
    expect(closeEvent.code).toBe(4401);
    expect(closeEvent.reason).toBe("participant control credentials invalid or expired");
  });

  it("closes WebSocket connections when participant does not exist or has left", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.152" },
      body: JSON.stringify({ displayName: "Dorothy" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;

    const response = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket as WebSocket;
    socket.accept();

    const closed = nextClose(socket);
    socket.send(
      JSON.stringify({
        type: "auth",
        participantId: "00000000-0000-0000-0000-000000000000",
        token: created.rejoinToken,
      }),
    );

    const closeEvent = await closed;
    expect(closeEvent.code).toBe(4401);
    expect(closeEvent.reason).toBe("participant control credentials invalid or expired");
  });

  it("closes WebSocket connections that send invalid JSON as authentication message", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.147" },
      body: JSON.stringify({ displayName: "Ada" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;

    const response = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket as WebSocket;
    socket.accept();

    const closed = nextClose(socket);
    socket.send("this is invalid json {{{");

    const closeEvent = await closed;
    expect(closeEvent.code).toBe(4401);
    expect(closeEvent.reason).toBe("invalid authentication message");
  });

  it("closes WebSocket connections that send non-auth payload type", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.148" },
      body: JSON.stringify({ displayName: "Ada" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;

    const response = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket as WebSocket;
    socket.accept();

    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "other_event" }));

    const closeEvent = await closed;
    expect(closeEvent.code).toBe(4401);
    expect(closeEvent.reason).toBe("authentication required");
  });

  it("closes WebSocket connections that send invalid credential types or lengths", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.149" },
      body: JSON.stringify({ displayName: "Ada" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;

    // Test case 1: empty participantId
    const response1 = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response1.status).toBe(101);
    const socket1 = response1.webSocket as WebSocket;
    socket1.accept();

    const closed1 = nextClose(socket1);
    socket1.send(
      JSON.stringify({
        type: "auth",
        participantId: "",
        token: created.rejoinToken,
      }),
    );

    const closeEvent1 = await closed1;
    expect(closeEvent1.code).toBe(4401);
    expect(closeEvent1.reason).toBe("participant control credentials required");

    // Test case 2: non-string participantId (e.g. number)
    const response2 = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response2.status).toBe(101);
    const socket2 = response2.webSocket as WebSocket;
    socket2.accept();

    const closed2 = nextClose(socket2);
    socket2.send(
      JSON.stringify({
        type: "auth",
        participantId: 12345,
        token: created.rejoinToken,
      }),
    );

    const closeEvent2 = await closed2;
    expect(closeEvent2.code).toBe(4401);
    expect(closeEvent2.reason).toBe("participant control credentials required");

    // Test case 3: oversized token (> 128 chars)
    const response3 = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response3.status).toBe(101);
    const socket3 = response3.webSocket as WebSocket;
    socket3.accept();

    const closed3 = nextClose(socket3);
    socket3.send(
      JSON.stringify({
        type: "auth",
        participantId: created.participant.id,
        token: "a".repeat(129),
      }),
    );

    const closeEvent3 = await closed3;
    expect(closeEvent3.code).toBe(4401);
    expect(closeEvent3.reason).toBe("participant control credentials required");
  });

  it("closes WebSocket connections that send binary messages or invalid post-auth messages", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.150" },
      body: JSON.stringify({ displayName: "Ada" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;

    // Test 1: Binary message before auth
    const response1 = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response1.status).toBe(101);
    const socket1 = response1.webSocket as WebSocket;
    socket1.accept();

    const closed1 = nextClose(socket1);
    socket1.send(new Uint8Array([1, 2, 3, 4]));

    const closeEvent1 = await closed1;
    expect(closeEvent1.code).toBe(1003);
    expect(closeEvent1.reason).toBe("control messages only");

    // Test 2: Invalid non-ping message post auth
    const response2 = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response2.status).toBe(101);
    const socket2 = response2.webSocket as WebSocket;
    socket2.accept();

    socket2.send(
      JSON.stringify({
        type: "auth",
        participantId: created.participant.id,
        token: created.rejoinToken,
      }),
    );
    await nextMessage(socket2);

    const closed2 = nextClose(socket2);
    socket2.send("unrecognized_command");

    const closeEvent2 = await closed2;
    expect(closeEvent2.code).toBe(1003);
    expect(closeEvent2.reason).toBe("control messages only");
  });

  it("does not accept legacy query-string credentials", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.48" },
      body: JSON.stringify({ displayName: "Radia" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;
    const response = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events?participant=${created.participant.id}&token=${created.rejoinToken}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket as WebSocket;
    socket.accept();

    const closed = nextClose(socket);
    socket.send("ping");
    expect((await closed).code).toBe(4401);
  });

  it("rejects oversized authentication messages before parsing them", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.49" },
      body: JSON.stringify({ displayName: "Vint" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;
    const response = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket as WebSocket;
    socket.accept();

    const closed = nextClose(socket);
    socket.send("x".repeat(513));
    expect((await closed).code).toBe(1009);
  });

  it("closes a connection whose initial authentication deadline expires", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.50" },
      body: JSON.stringify({ displayName: "Barbara" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;
    const response = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket as WebSocket;
    socket.accept();

    const rooms = env.ROOMS;
    if (!rooms)
      throw new Error("The ROOMS binding is required for the authentication-timeout test.");
    const stub = rooms.getByName(created.room.code);
    const closed = nextClose(socket);
    await runInDurableObject(stub, async (instance, state) => {
      const serverSocket = state.getWebSockets()[0];
      expect(serverSocket).toBeDefined();
      serverSocket?.serializeAttachment({
        participantId: null,
        authDeadline: Date.now() - 1,
      });
      await instance.alarm();
    });

    expect((await closed).code).toBe(4408);
  });

  it("enforces one active WebSocket connection per participant ID by closing previous socket", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.51" },
      body: JSON.stringify({ displayName: "Margaret" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;

    const res1 = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(res1.status).toBe(101);
    const socket1 = res1.webSocket as WebSocket;
    socket1.accept();

    socket1.send(
      JSON.stringify({
        type: "auth",
        participantId: created.participant.id,
        token: created.rejoinToken,
      }),
    );
    await nextMessage(socket1);

    const res2 = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events`,
      { headers: { upgrade: "websocket" } },
    );
    expect(res2.status).toBe(101);
    const socket2 = res2.webSocket as WebSocket;
    socket2.accept();

    const socket1Closed = nextClose(socket1);
    socket2.send(
      JSON.stringify({
        type: "auth",
        participantId: created.participant.id,
        token: created.rejoinToken,
      }),
    );

    const closeEvent = await socket1Closed;
    expect(closeEvent.code).toBe(4000);
    expect(closeEvent.reason).toBe("replaced by new connection");

    const snapshot2 = await nextMessage(socket2);
    expect(JSON.parse(String(snapshot2.data))).toMatchObject({ type: "snapshot" });
    socket2.close(1000, "test complete");
  });
});

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}
