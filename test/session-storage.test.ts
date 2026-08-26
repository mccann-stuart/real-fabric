import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  loadSession,
  normaliseCode,
  roomEventsUrl,
  type StoredSession,
  storeSession,
} from "../src/client/api";

const storage = new Map<string, string>();
const mockSessionStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
};

if (typeof globalThis.sessionStorage === "undefined") {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: mockSessionStorage,
    writable: true,
    configurable: true,
  });
}

if (typeof globalThis.location === "undefined") {
  Object.defineProperty(globalThis, "location", {
    value: { href: "https://example.com/demo/" },
    writable: true,
    configurable: true,
  });
}

describe("session storage and API helper utilities", () => {
  beforeEach(() => {
    storage.clear();
  });

  describe("storeSession", () => {
    it("attaches storedAt timestamp and persists session to sessionStorage", () => {
      const now = 1700000000000;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);

      const input = {
        code: "room-abc-123",
        participantId: "part-123",
        rejoinToken: "token-xyz",
        displayName: "Alice",
      };

      const result = storeSession(input);

      expect(result).toEqual({
        ...input,
        storedAt: now,
      });

      const raw = sessionStorage.getItem("real-fabric:room-abc-123");
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw ?? "")).toEqual(result);

      dateSpy.mockRestore();
    });
  });

  describe("loadSession", () => {
    it("loads valid session with normalized code", () => {
      const session: StoredSession = {
        code: "ROOM123",
        participantId: "part-123",
        rejoinToken: "token-xyz",
        displayName: "Bob",
        storedAt: 1690000000000,
      };

      sessionStorage.setItem("real-fabric:ROOM123", JSON.stringify(session));

      const loaded = loadSession("room-123");
      expect(loaded).toEqual(session);
    });

    it("returns null when session does not exist", () => {
      expect(loadSession("nonexistent")).toBeNull();
    });

    it("returns null when stored JSON is invalid", () => {
      sessionStorage.setItem("real-fabric:BADROOM", "{ invalid json");
      expect(loadSession("badroom")).toBeNull();
    });

    it("returns null when missing participantId or rejoinToken", () => {
      sessionStorage.setItem(
        "real-fabric:MISSINGPART",
        JSON.stringify({ code: "MISSINGPART", rejoinToken: "token-1" }),
      );
      expect(loadSession("missingpart")).toBeNull();

      sessionStorage.setItem(
        "real-fabric:MISSINGTOKEN",
        JSON.stringify({ code: "MISSINGTOKEN", participantId: "part-1" }),
      );
      expect(loadSession("missingtoken")).toBeNull();
    });

    it("defaults storedAt to current timestamp if omitted in stored session", () => {
      const now = 1710000000000;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);

      sessionStorage.setItem(
        "real-fabric:NOTIMESTAMP",
        JSON.stringify({
          code: "NOTIMESTAMP",
          participantId: "part-1",
          rejoinToken: "token-1",
          displayName: "Charlie",
        }),
      );

      const loaded = loadSession("notimestamp");
      expect(loaded).toEqual({
        code: "NOTIMESTAMP",
        participantId: "part-1",
        rejoinToken: "token-1",
        displayName: "Charlie",
        storedAt: now,
      });

      dateSpy.mockRestore();
    });
  });

  describe("clearSession", () => {
    it("removes session from sessionStorage using normalized code", () => {
      sessionStorage.setItem(
        "real-fabric:ROOMTOREMOVE",
        JSON.stringify({
          code: "ROOMTOREMOVE",
          participantId: "part-1",
          rejoinToken: "token-1",
          displayName: "Dave",
          storedAt: 1000,
        }),
      );

      clearSession("room-to-remove");
      expect(sessionStorage.getItem("real-fabric:ROOMTOREMOVE")).toBeNull();
    });
  });

  describe("normaliseCode", () => {
    it("strips non-alphanumeric chars, converts to uppercase, and limits to 20 chars", () => {
      expect(normaliseCode("  abc-123_xyz!  ")).toBe("ABC123XYZ");
      expect(normaliseCode("1234567890abcdefghijklmnopqrstuvwxyz")).toBe("1234567890ABCDEFGHIJ");
    });
  });

  describe("roomEventsUrl", () => {
    it("builds a credential-free WebSocket URL using the current location", () => {
      const session: StoredSession = {
        code: "ROOM1",
        participantId: "part-456",
        rejoinToken: "token-789",
        displayName: "Eve",
        storedAt: 123456,
      };

      const url = roomEventsUrl(session);
      const parsed = new URL(url);

      expect(["ws:", "wss:"]).toContain(parsed.protocol);
      expect(parsed.pathname).toBe("/api/rooms/ROOM1/events");
      expect(parsed.search).toBe("");
      expect(url).not.toContain(session.participantId);
      expect(url).not.toContain(session.rejoinToken);
    });
  });
});
