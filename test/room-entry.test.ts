import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredSession } from "../src/client/api";
import { openRoomEntry, stageRoomEntry } from "../src/client/room/roomEntry";
import type { JoinRoomResponse, RoomSnapshot } from "../src/shared/contracts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("room entry and reclaim", () => {
  it("uses the first entry response once, then rejoins a stored identity on reload", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const stored: StoredSession = {
      code: "ROOMCODE123456789012",
      participantId: "human-1",
      rejoinToken: "rejoin-1",
      displayName: "Ada",
      storedAt: Date.now(),
    };
    const room = {
      code: stored.code,
      routing: [{ humanId: "human-1", aiId: "ai-1" }],
    } as RoomSnapshot;
    const rejoined: JoinRoomResponse = {
      room,
      participant: { id: stored.participantId } as JoinRoomResponse["participant"],
      rejoinToken: stored.rejoinToken,
      relayCredential: null,
      correlationId: "correlation-1",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(rejoined), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    stageRoomEntry(stored, room);
    const firstMount = await openRoomEntry(stored);
    expect(firstMount).toEqual({ room, session: stored, reclaimed: false });
    expect(fetchMock).not.toHaveBeenCalled();

    const reload = await openRoomEntry(stored);
    expect(reload.room).toEqual(room);
    expect(reload.session.participantId).toBe(stored.participantId);
    expect(reload.reclaimed).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/rooms/${stored.code}/join`);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      displayName: stored.displayName,
      rejoinToken: stored.rejoinToken,
    });
    expect(JSON.parse(values.get(`real-fabric:${stored.code}`) ?? "null").participantId).toBe(
      stored.participantId,
    );
  });
});
