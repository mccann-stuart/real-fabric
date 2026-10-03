import { useCallback, useEffect, useRef, useState } from "react";
import { leaveRoom, type StoredSession, signalLeaveOnUnload } from "../api";
import { openRoomEntry } from "../room/roomEntry";
import { RoomSession, type SessionState } from "../session/RoomSession";

/**
 * H12: reload inside the 60-second window reclaims the same identity and
 * routing.
 *
 * A later mount re-presents the stored rejoin token. The first mount uses the
 * room snapshot already returned by create/join, so it does not join twice.
 */

export interface RoomSessionHandle {
  state: SessionState | null;
  session: RoomSession | null;
  /** True when a later mount reclaimed the stored identity, not on first entry. */
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
  const openingRef = useRef<ReturnType<typeof openRoomEntry> | null>(null);

  useEffect(() => {
    if (!stored) return;
    // React Strict Mode replays effects. Share the opening result so that its
    // second setup cannot consume the handoff and issue a redundant join.
    openingRef.current ??= openRoomEntry(stored);
    const opening = openingRef.current;
    let disposed = false;
    let created: RoomSession | null = null;
    let unsubscribe: (() => void) | undefined;

    const run = async () => {
      try {
        const opened = await opening;
        if (disposed) return;

        currentRef.current = opened.session;
        setReclaimed(opened.reclaimed);

        created = new RoomSession({ session: opened.session, presenterMode });
        sessionRef.current = created;
        unsubscribe = created.subscribe(setState);
        await created.start(opened.room);
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
