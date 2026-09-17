import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  clearSession,
  fetchHealth,
  leaveRoom,
  loadSession,
  markActive,
  normaliseCode,
  signalLeaveOnUnload,
  storeSession,
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

  describe("leaveRoom", () => {
    it("posts to leave endpoint with session credentials and returns room snapshot", async () => {
      const mockSnapshot = { code: "ROOM123", participants: [] };
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockSnapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const session = {
        code: "ROOM123",
        participantId: "p-1",
        rejoinToken: "token-abc",
        displayName: "Alice",
        storedAt: 123456789,
      };

      const snapshot = await leaveRoom(session);

      expect(snapshot).toEqual(mockSnapshot);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = mockFetch.mock.calls[0];
      if (!call) throw new Error("Expected fetch to be called");
      const [url, init] = call as [string, RequestInit];
      expect(url).toBe("/api/rooms/ROOM123/leave");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        participantId: "p-1",
        rejoinToken: "token-abc",
      });
    });
  });

  describe("signalLeaveOnUnload", () => {
    it("triggers fire-and-forget fetch with keepalive: true and session credentials", () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      const session = {
        code: "ROOM123",
        participantId: "p-1",
        rejoinToken: "token-abc",
        displayName: "Alice",
        storedAt: 123456789,
      };

      signalLeaveOnUnload(session);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = mockFetch.mock.calls[0];
      if (!call) throw new Error("Expected fetch to be called");
      const [url, init] = call as [string, RequestInit];
      expect(url).toBe("/api/rooms/ROOM123/leave");
      expect(init.method).toBe("POST");
      expect(init.keepalive).toBe(true);
      expect(init.headers).toEqual({ "content-type": "application/json" });
      expect(JSON.parse(init.body as string)).toEqual({
        participantId: "p-1",
        rejoinToken: "token-abc",
      });
    });

    it("handles network error rejection gracefully without throwing", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new TypeError("Network error"));
      vi.stubGlobal("fetch", mockFetch);

      const session = {
        code: "ROOM123",
        participantId: "p-1",
        rejoinToken: "token-abc",
        displayName: "Alice",
        storedAt: 123456789,
      };

      expect(() => signalLeaveOnUnload(session)).not.toThrow();

      // Wait for promise microtask queue to ensure catch block is executed without unhandled rejection
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
