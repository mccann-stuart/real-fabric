import { useCallback, useEffect, useRef, useState } from "react";
import { joinRoom, leaveRoom, type StoredSession, signalLeaveOnUnload, storeSession } from "../api";
import { RoomSession, rememberRelayCredential, type SessionState } from "../session/RoomSession";

/**
 * H12: reload inside the 60-second window reclaims the same identity and
 * routing.
 *
 * The reclaim happens here, on mount, by re-presenting the stored single-use
 * rejoin token. Without this the browser would hold a token it never spends and
 * the server would time the participant out mid-demo.
 */

/**
 * Marks that this browser has already mounted the room for this code. A mount
 * without the mark is the first arrival; a mount with it is a reload. The
 * server cannot tell these apart — a plain reload never sends a leave — so the
 * distinction has to be recorded here, and the H12 banner depends on it being
 * honest.
 */
function markMounted(code: string): boolean {
  const key = `real-fabric:mounted:${code}`;
  const seen = sessionStorage.getItem(key) === "true";
  sessionStorage.setItem(key, "true");
  return seen;
}

export function clearMountMark(code: string): void {
  sessionStorage.removeItem(`real-fabric:mounted:${code}`);
}

export interface RoomSessionHandle {
  state: SessionState | null;
  session: RoomSession | null;
  /** True when this mount reclaimed an identity after a reload, not on first join. */
  reclaimed: boolean;
  error: string;
  startAudio: () => Promise<void>;
  setMuted: (muted: boolean) => void;
  retry: () => Promise<void>;
  /** Closes locally and tells the room service, starting the 60-second window. */
  leave: () => Promise<void>;
}

export function useRoomSession(
  stored: StoredSession | null,
  presenterMode: boolean,
): RoomSessionHandle {
  const [state, setState] = useState<SessionState | null>(null);
  const [reclaimed, setReclaimed] = useState(false);
  const [error, setError] = useState("");
  const sessionRef = useRef<RoomSession | null>(null);
  const currentRef = useRef<StoredSession | null>(null);

  useEffect(() => {
    if (!stored) return;
    let disposed = false;
    let created: RoomSession | null = null;
    let unsubscribe: (() => void) | undefined;
    const isReload = markMounted(stored.code);

    const run = async () => {
      try {
        // Presenting the stored token is the reclaim. The server returns the
        // same participant id when the window is still open, and a new one
        // when it is not — either way the client ends up with a valid identity.
        const joined = await joinRoom(stored.code, stored.displayName, stored.rejoinToken);
        if (disposed) return;

        const refreshed = storeSession({
          code: joined.room.code,
          participantId: joined.participant.id,
          rejoinToken: joined.rejoinToken,
          displayName: stored.displayName,
        });
        currentRef.current = refreshed;
        // §8: held in memory only, never stored and never in a shareable URL.
        rememberRelayCredential(joined.participant.id, joined.relayCredential);
        setReclaimed(isReload && joined.participant.id === stored.participantId);

        created = new RoomSession({ session: refreshed, presenterMode });
        sessionRef.current = created;
        unsubscribe = created.subscribe(setState);
        await created.start(joined.room);
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "The room session could not start.");
        }
      }
    };
    void run();

    return () => {
      disposed = true;
      unsubscribe?.();
      void created?.close();
      sessionRef.current = null;
    };
    // `stored` must be a stable reference from the caller: re-running this
    // would tear down a live session and rejoin mid-demo.
  }, [stored, presenterMode]);

  useEffect(() => {
    // A closed tab must start the 60-second window rather than leaving the
    // participant apparently connected until the room's hard stop.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void sessionRef.current?.interruptAudio(
          "Safari moved the room out of the foreground or locked the screen.",
        );
      }
    };
    const onPageHide = (event: PageTransitionEvent) => {
      void sessionRef.current?.interruptAudio("The room page was hidden.");
      // A bfcache page can return with the same control identity. A real
      // unload still starts the 60-second rejoin window.
      if (event.persisted) return;
      const session = currentRef.current;
      if (session) signalLeaveOnUnload(session);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void sessionRef.current?.interruptAudio(
        "Safari restored the room page; audio requires a new user action.",
      );
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    addEventListener("pagehide", onPageHide);
    addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      removeEventListener("pagehide", onPageHide);
      removeEventListener("pageshow", onPageShow);
    };
  }, []);

  const startAudio = useCallback(async () => {
    await sessionRef.current?.startAudio();
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    sessionRef.current?.setMuted(muted);
  }, []);

  const retry = useCallback(async () => {
    await sessionRef.current?.retry();
  }, []);

  const leave = useCallback(async () => {
    // §4.4: close capture, publications and subscriptions locally, then tell
    // the room service so the rejoin window starts.
    await sessionRef.current?.close();
    const session = currentRef.current;
    if (!session) return;
    clearMountMark(session.code);
    try {
      await leaveRoom(session);
    } catch {
      // The local session is already closed; a failed notification only means
      // the server times the participant out instead.
    }
  }, []);

  return {
    state,
    session: sessionRef.current,
    reclaimed,
    error,
    startAudio,
    setMuted,
    retry,
    leave,
  };
}
