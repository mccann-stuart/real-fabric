import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  addAi,
  clearSession,
  configurePresenter,
  createRoom,
  fetchHealth,
  fetchRoom,
  joinRoom,
  leaveRoom,
  loadSession,
  markActive,
  normaliseCode,
  recordAiToAiTurn,
  releaseFloor,
  removeAi,
  requestFloor,
  type StoredSession,
  setAiPipeline,
  setAiToAi,
  signalLeaveOnUnload,
  storeSession,
  updateRouting,
} from "../src/client/api";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

if (typeof globalThis.sessionStorage === "undefined") {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: new MemoryStorage(),
    writable: true,
  });
}

describe("client API session management", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("request error handling", () => {
    it("returns parsed JSON on successful response", async () => {
      const mockData = { ok: true, service: "test" };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(mockData), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

      const res = await fetchHealth();
      expect(res).toEqual(mockData);
    });

    it("adds a UUID correlation ID to outgoing requests", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await fetchHealth();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith("/api/health", {
        headers: {
          "x-correlation-id": expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        },
      });
    });

    it("returns undefined on HTTP 204 No Content response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(null, {
            status: 204,
          }),
        ),
      );

      const session = {
        code: "ROOM123",
        participantId: "p-1",
        rejoinToken: "token-abc",
        displayName: "Alice",
        storedAt: 123456789,
      };

      const res = await markActive(session, "p-1");
      expect(res).toBeUndefined();
    });

    it("throws ApiClientError with problem details when response is not ok and JSON is valid ApiError", async () => {
      const apiError = {
        error: {
          code: "room_not_found",
          message: "Room was not found",
          correlationId: "corr-123",
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify(apiError), {
              status: 404,
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      );

      try {
        await fetchHealth();
        expect.unreachable("fetchHealth should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        const clientErr = err as ApiClientError;
        expect(clientErr.code).toBe("room_not_found");
        expect(clientErr.message).toBe("Room was not found");
        expect(clientErr.correlationId).toBe("corr-123");
      }
    });

    it("throws ApiClientError fallback when response is not ok and JSON parsing fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() =>
          Promise.resolve(
            new Response("Internal Server Error HTML or text", {
              status: 500,
              headers: { "content-type": "text/html" },
            }),
          ),
        ),
      );

      try {
        await fetchHealth();
        expect.unreachable("fetchHealth should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        const clientErr = err as ApiClientError;
        expect(clientErr.code).toBe("http_error");
        expect(clientErr.message).toBe("Request failed with HTTP 500.");
        expect(clientErr.correlationId).toBe("not-exposed");
      }
    });
  });

  describe("normaliseCode", () => {
    it("converts code to uppercase and strips non-alphanumeric characters", () => {
      expect(normaliseCode("abc-123_xyz!")).toBe("ABC123XYZ");
    });

    it("truncates normalised code to 20 characters", () => {
      expect(normaliseCode("abcdefghijklmnopqrstuvwxyz123456")).toBe("ABCDEFGHIJKLMNOPQRST");
    });
  });

  describe("storeSession", () => {
    it("stores session in sessionStorage with storedAt timestamp", () => {
      const input = {
        code: "room-123",
        participantId: "p-1",
        rejoinToken: "token-abc",
        displayName: "Alice",
      };

      const before = Date.now();
      const stored = storeSession(input);
      const after = Date.now();

      expect(stored.code).toBe("room-123");
      expect(stored.participantId).toBe("p-1");
      expect(stored.rejoinToken).toBe("token-abc");
      expect(stored.displayName).toBe("Alice");
      expect(stored.storedAt).toBeGreaterThanOrEqual(before);
      expect(stored.storedAt).toBeLessThanOrEqual(after);

      const raw = sessionStorage.getItem("real-fabric:room-123");
      expect(raw).not.toBeNull();
      if (raw) {
        expect(JSON.parse(raw)).toEqual(stored);
      }
    });
  });

  describe("loadSession", () => {
    it("loads a valid session from sessionStorage", () => {
      const session = {
        code: "ROOM123",
        participantId: "p-1",
        rejoinToken: "token-abc",
        displayName: "Bob",
        storedAt: 123456789,
      };
      sessionStorage.setItem("real-fabric:ROOM123", JSON.stringify(session));

      const loaded = loadSession("room-123");
      expect(loaded).toEqual(session);
    });

    it("returns null if session does not exist", () => {
      expect(loadSession("nonexistent")).toBeNull();
    });

    it("returns null if session JSON is malformed", () => {
      sessionStorage.setItem("real-fabric:ROOM123", "invalid-json{");
      expect(loadSession("room-123")).toBeNull();
    });

    it("returns null if session is missing participantId or rejoinToken", () => {
      sessionStorage.setItem(
        "real-fabric:ROOM123",
        JSON.stringify({ code: "ROOM123", displayName: "Bob" }),
      );
      expect(loadSession("room-123")).toBeNull();
    });

    it("returns null when parsed JSON is null or a non-object primitive", () => {
      sessionStorage.setItem("real-fabric:ROOM123", "null");
      expect(loadSession("room-123")).toBeNull();

      sessionStorage.setItem("real-fabric:ROOM123", JSON.stringify("just a string"));
      expect(loadSession("room-123")).toBeNull();

      sessionStorage.setItem("real-fabric:ROOM123", JSON.stringify(12345));
      expect(loadSession("room-123")).toBeNull();

      sessionStorage.setItem("real-fabric:ROOM123", JSON.stringify(true));
      expect(loadSession("room-123")).toBeNull();

      sessionStorage.setItem("real-fabric:ROOM123", JSON.stringify(["array"]));
      expect(loadSession("room-123")).toBeNull();
    });

    it("defaults storedAt to Date.now() if missing in loaded session", () => {
      const before = Date.now();
      sessionStorage.setItem(
        "real-fabric:ROOM123",
        JSON.stringify({
          code: "ROOM123",
          participantId: "p-1",
          rejoinToken: "token-abc",
          displayName: "Charlie",
        }),
      );
      const loaded = loadSession("room-123");
      const after = Date.now();

      expect(loaded).not.toBeNull();
      expect(loaded?.storedAt).toBeGreaterThanOrEqual(before);
      expect(loaded?.storedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("clearSession", () => {
    it("removes session from sessionStorage using normalised code", () => {
      const session = {
        code: "ROOM123",
        participantId: "p-1",
        rejoinToken: "token-abc",
        displayName: "Alice",
        storedAt: 123456789,
      };
      sessionStorage.setItem("real-fabric:ROOM123", JSON.stringify(session));
      expect(sessionStorage.getItem("real-fabric:ROOM123")).not.toBeNull();

      clearSession("room-123!");
      expect(sessionStorage.getItem("real-fabric:ROOM123")).toBeNull();
      expect(loadSession("room-123")).toBeNull();
    });
  });

  describe("API endpoint wrappers", () => {
    const dummySession: StoredSession = {
      code: "room-abc-123",
      participantId: "p-100",
      rejoinToken: "rt-200",
      displayName: "Tester",
      storedAt: 100000,
    };

    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
    });

    it("createRoom sends POST /api/rooms with displayName and correlation header", async () => {
      const res = await createRoom("Alice");
      expect(res).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
      expect((init.headers as Record<string, string>)["x-correlation-id"]).toBeDefined();
      expect(JSON.parse(init.body)).toEqual({ displayName: "Alice" });
    });

    it("joinRoom sends POST /api/rooms/:code/join without rejoinToken if not provided", async () => {
      await joinRoom("room-abc-123", "Bob");
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/ROOMABC123/join");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ displayName: "Bob" });
    });

    it("joinRoom sends POST /api/rooms/:code/join with rejoinToken if provided", async () => {
      await joinRoom("room-abc-123", "Bob", "token-xyz");
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/ROOMABC123/join");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        displayName: "Bob",
        rejoinToken: "token-xyz",
      });
    });

    it("fetchRoom sends POST /api/rooms/:code/snapshot with credentials", async () => {
      await fetchRoom(dummySession);
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/ROOMABC123/snapshot");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
      });
    });

    it("leaveRoom sends POST /api/rooms/:code/leave with credentials", async () => {
      await leaveRoom(dummySession);
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/leave");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
      });
    });

    it("signalLeaveOnUnload sends fire-and-forget POST request with keepalive", async () => {
      signalLeaveOnUnload(dummySession);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/leave");
      expect(init.method).toBe("POST");
      expect(init.keepalive).toBe(true);
      expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
      });
    });

    it("signalLeaveOnUnload suppresses network rejection errors silently", async () => {
      fetchMock.mockRejectedValue(new Error("Network disconnect on unload"));
      expect(() => signalLeaveOnUnload(dummySession)).not.toThrow();
    });

    it("updateRouting sends POST /api/rooms/:code/routing with credentials and routing state", async () => {
      await updateRouting(dummySession, "ai-1", true, false);
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/routing");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        aiId: "ai-1",
        hearsMe: true,
        iHearIt: false,
      });
    });

    it("addAi sends POST /api/rooms/:code/ai with basic options", async () => {
      await addAi(dummySession, "Assistant", { simulated: true });
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/ai");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        displayName: "Assistant",
        simulated: true,
      });
    });

    it("addAi sends POST /api/rooms/:code/ai with address and wakeName options", async () => {
      await addAi(dummySession, "Assistant", {
        address: "wss://ai.local",
        wakeName: "Hey Bot",
        simulated: false,
      });
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/ai");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        displayName: "Assistant",
        address: "wss://ai.local",
        wakeName: "Hey Bot",
        simulated: false,
      });
    });

    it("removeAi sends DELETE /api/rooms/:code/ai with credentials and aiId", async () => {
      await removeAi(dummySession, "ai-42");
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/ai");
      expect(init.method).toBe("DELETE");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        aiId: "ai-42",
      });
    });

    it("setAiPipeline sends POST /api/rooms/:code/ai-pipeline with credentials and pipeline configuration", async () => {
      const pipeline = "thinking" as const;
      await setAiPipeline(dummySession, "ai-42", pipeline);
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/ai-pipeline");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        aiId: "ai-42",
        pipeline,
      });
    });

    it("requestFloor sends POST /api/rooms/:code/floor with operation request", async () => {
      await requestFloor(dummySession, "ai-42");
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/floor");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        aiId: "ai-42",
        operation: "request",
      });
    });

    it("releaseFloor sends POST /api/rooms/:code/floor with operation release", async () => {
      await releaseFloor(dummySession, "ai-42");
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/floor");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        aiId: "ai-42",
        operation: "release",
      });
    });

    it("setAiToAi sends POST /api/rooms/:code/ai-to-ai with specified operation", async () => {
      await setAiToAi(dummySession, "enable");
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/ai-to-ai");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        operation: "enable",
      });
    });

    it("recordAiToAiTurn sends POST /api/rooms/:code/ai-to-ai with turn operation", async () => {
      await recordAiToAiTurn(dummySession);
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/ai-to-ai");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        operation: "turn",
      });
    });

    it("configurePresenter sends POST /api/rooms/:code/presenter with presenter config", async () => {
      const config = { simulatedHumans: 3, simulatedAis: 2, scriptedResponses: true };
      await configurePresenter(dummySession, config);
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/presenter");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        simulatedHumans: 3,
        simulatedAis: 2,
        scriptedResponses: true,
      });
    });

    it("markActive sends POST /api/rooms/:code/active with targetId and credentials", async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      await markActive(dummySession, "target-participant-id");
      const [url, init] = (fetchMock.mock.calls[0] ?? []) as [
        string,
        RequestInit & { body: string },
      ];
      expect(url).toBe("/api/rooms/room-abc-123/active");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        participantId: "p-100",
        rejoinToken: "rt-200",
        targetId: "target-participant-id",
      });
    });
  });
});
