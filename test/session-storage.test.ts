import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  loadSession,
  normaliseCode,
  roomEventsUrl,
  type StoredSession,
  storeSession,
} from "../src/client/api";
import { REJOIN_WINDOW_MS } from "../src/shared/contracts";

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

      // Normalised, so loadSession and clearSession look under the same key.
      const raw = sessionStorage.getItem("real-fabric:ROOMABC123");
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw ?? "")).toEqual(result);

      dateSpy.mockRestore();
    });

    it("round-trips through store, load and clear on one key", () => {
      const now = 1700000000000;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);

      const stored = storeSession({
        code: "room-abc-123",
        participantId: "part-123",
        rejoinToken: "token-xyz",
        displayName: "Alice",
      });

      // Composing the helpers is what catches a key the writer and reader
      // disagree about; asserting each half against a hand-built key cannot.
      expect(loadSession("room-abc-123")).toEqual(stored);
      expect(loadSession("ROOMABC123")).toEqual(stored);

      clearSession("room-abc-123");
      expect(loadSession("room-abc-123")).toBeNull();

      dateSpy.mockRestore();
    });
  });

  describe("loadSession", () => {
    it("loads valid session with normalized code", () => {
      const storedAt = 1690000000000;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(storedAt + 1_000);
      const session: StoredSession = {
        code: "ROOM123",
        participantId: "part-123",
        rejoinToken: "token-xyz",
        displayName: "Bob",
        storedAt,
      };

      sessionStorage.setItem("real-fabric:ROOM123", JSON.stringify(session));

      const loaded = loadSession("room-123");
      expect(loaded).toEqual(session);

      dateSpy.mockRestore();
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

    it("refuses a session that carries no usable storedAt rather than stamping one", () => {
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(1710000000000);

      // Stamping Date.now() here would make any later window check pass forever.
      for (const [code, storedAt] of [
        ["NOTIMESTAMP", undefined],
        ["NANTIMESTAMP", Number.NaN],
        ["INFTIMESTAMP", Number.POSITIVE_INFINITY],
      ] as const) {
        sessionStorage.setItem(
          `real-fabric:${code}`,
          JSON.stringify({
            code,
            participantId: "part-1",
            rejoinToken: "token-1",
            displayName: "Charlie",
            ...(storedAt === undefined ? {} : { storedAt }),
          }),
        );
        expect(loadSession(code)).toBeNull();
      }

      dateSpy.mockRestore();
    });

    it("reclaims inside the 60-second window and refuses one millisecond past it", () => {
      const storedAt = 1710000000000;
      const session: StoredSession = {
        code: "WINDOWROOM",
        participantId: "part-1",
        rejoinToken: "token-1",
        displayName: "Dana",
        storedAt,
      };
      sessionStorage.setItem("real-fabric:WINDOWROOM", JSON.stringify(session));

      // H12 promises reload *within* 60 seconds, so the bound itself reclaims.
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(storedAt + REJOIN_WINDOW_MS);
      expect(loadSession("windowroom")).toEqual(session);

      dateSpy.mockReturnValue(storedAt + REJOIN_WINDOW_MS + 1);
      expect(loadSession("windowroom")).toBeNull();

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
