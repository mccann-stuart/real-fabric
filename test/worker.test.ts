import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CreateRoomResponse } from "../src/shared/contracts";

describe("Real Fabric Worker", () => {
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
      // Gate 1 has not run. Naming the endpoint is not claiming it works.
      transportVerified: false,
      routingEnforcement: "cooperative",
      discovery: "unknown",
    });
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

  it("returns a specific not-found response for an unknown room", async () => {
    const response = await SELF.fetch("https://real-fabric.test/api/rooms/AAAAAAAAAAAAAAAAAAAA");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: {
        code: "room_not_found",
        message: "The room does not exist or has expired.",
      },
    });
  });

  it("uses WebSockets for authenticated control messages only", async () => {
    const createdResponse = await SELF.fetch("https://real-fabric.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.46" },
      body: JSON.stringify({ displayName: "Katherine" }),
    });
    const created = (await createdResponse.json()) as CreateRoomResponse;
    const response = await SELF.fetch(
      `https://real-fabric.test/api/rooms/${created.room.code}/events?participant=${created.participant.id}&token=${created.rejoinToken}`,
      { headers: { upgrade: "websocket" } },
    );

    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const snapshot = await nextMessage(socket as WebSocket);
    expect(JSON.parse(String(snapshot.data))).toMatchObject({ type: "snapshot" });

    socket?.send("ping");
    const pong = await nextMessage(socket as WebSocket);
    expect(pong.data).toBe("pong");
    socket?.close(1000, "test complete");
  });
});

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
}
