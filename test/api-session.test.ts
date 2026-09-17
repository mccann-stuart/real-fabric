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
  roomEventsUrl,
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

  describe("ApiClientError and request handling", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("creates an ApiClientError with code, message, and correlationId", () => {
      const err = new ApiClientError("test_code", "Test message", "corr-1");
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("test_code");
      expect(err.message).toBe("Test message");
      expect(err.correlationId).toBe("corr-1");
    });

    it("handles non-ok HTTP responses with non-JSON error bodies (untested error path)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );

      await expect(fetchHealth()).rejects.toThrow(ApiClientError);

      try {
        await fetchHealth();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        const apiErr = err as ApiClientError;
        expect(apiErr.code).toBe("http_error");
        expect(apiErr.message).toBe("Request failed with HTTP 500.");
        expect(apiErr.correlationId).toBe("not-exposed");
      }
    });

    it("handles non-ok HTTP responses with valid ApiError JSON body", async () => {
      const apiErrorBody = {
        error: {
          code: "invalid_request",
          message: "Display name is required.",
          correlationId: "corr-abc-123",
        },
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(apiErrorBody), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );

      try {
        await createRoom("");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        const apiErr = err as ApiClientError;
        expect(apiErr.code).toBe("invalid_request");
        expect(apiErr.message).toBe("Display name is required.");
        expect(apiErr.correlationId).toBe("corr-abc-123");
      }
    });

    it("returns undefined for 204 No Content responses", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 204 }));

      const session = {
        code: "ROOM123",
        participantId: "p1",
        rejoinToken: "tok1",
        displayName: "Alice",
        storedAt: Date.now(),
      };

      const result = await markActive(session, "p1");
      expect(result).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/rooms/ROOM123/active",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "content-type": "application/json",
            "x-correlation-id": expect.any(String),
          }),
        }),
      );
    });

    it("injects x-correlation-id header on all outgoing requests", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      await fetchHealth();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const callArgs = fetchSpy.mock.calls[0];
      expect(callArgs).toBeDefined();
      if (!callArgs) return;
      expect(callArgs[0]).toBe("/api/health");
      const init = callArgs[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["x-correlation-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("handles signalLeaveOnUnload without throwing on fetch rejection", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disconnect"));

      const session = {
        code: "ROOM123",
        participantId: "p1",
        rejoinToken: "tok1",
        displayName: "Alice",
        storedAt: Date.now(),
      };

      expect(() => signalLeaveOnUnload(session)).not.toThrow();
    });

    it("formats roomEventsUrl with wss: or ws: protocol depending on location.href", () => {
      const originalLocation = globalThis.location;
      Object.defineProperty(globalThis, "location", {
        value: new URL("https://real-fabric.test/room/ROOM123"),
        writable: true,
        configurable: true,
      });

      try {
        const session = {
          code: "ROOM123",
          participantId: "p1",
          rejoinToken: "tok1",
          displayName: "Alice",
          storedAt: Date.now(),
        };

        const wsUrl = roomEventsUrl(session);
        expect(wsUrl).toBe("wss://real-fabric.test/api/rooms/ROOM123/events");
      } finally {
        if (originalLocation === undefined) {
          // @ts-expect-error cleanup mock
          delete globalThis.location;
        } else {
          globalThis.location = originalLocation;
        }
      }
    });

    it("invokes client API methods correctly", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        );

      const session = {
        code: "ROOM123",
        participantId: "p1",
        rejoinToken: "tok1",
        displayName: "Alice",
        storedAt: Date.now(),
      };

      await joinRoom("ROOM123", "Alice", "tok1");
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/join",
        expect.objectContaining({
          body: JSON.stringify({ displayName: "Alice", rejoinToken: "tok1" }),
        }),
      );

      await fetchRoom(session);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/snapshot",
        expect.objectContaining({
          body: JSON.stringify({ participantId: "p1", rejoinToken: "tok1" }),
        }),
      );

      await leaveRoom(session);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/leave",
        expect.objectContaining({
          body: JSON.stringify({ participantId: "p1", rejoinToken: "tok1" }),
        }),
      );

      await updateRouting(session, "ai-1", true, false);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/routing",
        expect.objectContaining({
          body: JSON.stringify({
            participantId: "p1",
            rejoinToken: "tok1",
            aiId: "ai-1",
            hearsMe: true,
            iHearIt: false,
          }),
        }),
      );

      await addAi(session, "Bot", { address: "ai://bot", wakeName: "bot", simulated: true });
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/ai",
        expect.objectContaining({
          body: JSON.stringify({
            participantId: "p1",
            rejoinToken: "tok1",
            displayName: "Bot",
            address: "ai://bot",
            wakeName: "bot",
            simulated: true,
          }),
        }),
      );

      await removeAi(session, "ai-1");
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/ai",
        expect.objectContaining({
          method: "DELETE",
          body: JSON.stringify({ participantId: "p1", rejoinToken: "tok1", aiId: "ai-1" }),
        }),
      );

      await setAiPipeline(session, "ai-1", "listening");
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/ai-pipeline",
        expect.objectContaining({
          body: JSON.stringify({
            participantId: "p1",
            rejoinToken: "tok1",
            aiId: "ai-1",
            pipeline: "listening",
          }),
        }),
      );

      await requestFloor(session, "ai-1");
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/floor",
        expect.objectContaining({
          body: JSON.stringify({
            participantId: "p1",
            rejoinToken: "tok1",
            aiId: "ai-1",
            operation: "request",
          }),
        }),
      );

      await releaseFloor(session, "ai-1");
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/floor",
        expect.objectContaining({
          body: JSON.stringify({
            participantId: "p1",
            rejoinToken: "tok1",
            aiId: "ai-1",
            operation: "release",
          }),
        }),
      );

      await setAiToAi(session, "enable");
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/ai-to-ai",
        expect.objectContaining({
          body: JSON.stringify({
            participantId: "p1",
            rejoinToken: "tok1",
            operation: "enable",
          }),
        }),
      );

      await recordAiToAiTurn(session);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/ai-to-ai",
        expect.objectContaining({
          body: JSON.stringify({
            participantId: "p1",
            rejoinToken: "tok1",
            operation: "turn",
          }),
        }),
      );

      await configurePresenter(session, {
        simulatedHumans: 2,
        simulatedAis: 3,
        scriptedResponses: true,
      });
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/rooms/ROOM123/presenter",
        expect.objectContaining({
          body: JSON.stringify({
            participantId: "p1",
            rejoinToken: "tok1",
            simulatedHumans: 2,
            simulatedAis: 3,
            scriptedResponses: true,
          }),
        }),
      );
    });
  });
});
