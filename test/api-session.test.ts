import { beforeEach, describe, expect, it } from "vitest";
import { clearSession, loadSession, normaliseCode, storeSession } from "../src/client/api";

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
});
