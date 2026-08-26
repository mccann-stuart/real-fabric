import type { FailureCode } from "../../shared/failures";
import { punctuateReason } from "../room/roomPresentation";
import type { SessionState } from "../session/RoomSession";
import { FailureList } from "./FailureBanner";
import { PinnedConfigBanner } from "./PinnedConfigBanner";

interface RoomStatusStackProps {
  state: SessionState | null;
  reclaimed: boolean;
  error: string | null;
  iphoneAudioCandidate: boolean;
  hiddenFailureCodes: FailureCode[];
  onRetry: () => void;
  onDismissFailure: (failureCode: FailureCode) => void;
}

export function RoomStatusStack({
  state,
  reclaimed,
  error,
  iphoneAudioCandidate,
  hiddenFailureCodes,
  onRetry,
  onDismissFailure,
}: RoomStatusStackProps) {
  const room = state?.room ?? null;

  return (
    <div className="room-status-stack">
      <h2 className="sr-only">Room status</h2>
      {/* H3 */}
      <PinnedConfigBanner />
      <div className="mobile-warning" role="status">
        {iphoneAudioCandidate ? (
          <>
            <b>!</b> iPhone Safari 27+ audio candidate · foreground only · physical acceptance
            pending
          </>
        ) : (
          <>
            <b>!</b> Desktop Chrome or iPhone Safari 27+ required for live audio
          </>
        )}
      </div>

      {reclaimed ? (
        <p className="reclaim-banner" role="status">
          Identity and routing reclaimed inside the 60-second window. Nothing was played twice.
        </p>
      ) : null}

      {state?.phase.name === "terminal" ? (
        <p className="error-banner" role="alert">
          Reconnection was abandoned after 30 seconds.{" "}
          <button type="button" onClick={onRetry}>
            Retry now
          </button>
        </p>
      ) : null}

      {state?.phase.name === "resume_required" ? (
        <p className="audio-resume-banner" role="status">
          <b>Audio paused.</b> {state.phase.reason} Return to the foreground and tap Resume audio.
        </p>
      ) : null}

      {state?.phase.name === "live" &&
      (state.audioLifecycle.wakeLock === "denied" ||
        state.audioLifecycle.wakeLock === "released") ? (
        <p className="audio-lifecycle-note" role="status">
          {state.audioLifecycle.wakeLockReason} Audio remains foreground-only.
        </p>
      ) : null}

      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}

      {/* H7: the engaged degradation step is named, never silent. */}
      {state?.degradation.announcement ? (
        <p className="degradation-banner" role="status">
          <b>Capacity protection:</b> {state.degradation.announcement}
        </p>
      ) : null}

      {/* §11.3: listen-only is a named mode. The one retry action stays in the header. */}
      {state?.capture.name === "listen_only" ? (
        <section className="degradation-banner listen-only-banner" role="status">
          <b>Listen-only.</b> Listening and the inspector are unaffected.
          <details>
            <summary>Technical reason</summary>
            <code>{punctuateReason(state.capture.reason)}</code>
          </details>
        </section>
      ) : null}
      {state?.capture.name === "listen_only_device_available" ? (
        <section className="degradation-banner listen-only-banner" role="status">
          <b>Microphone available.</b> Use Start microphone when you are ready.
          <details>
            <summary>Previous technical reason</summary>
            <code>{punctuateReason(state.capture.reason)}</code>
          </details>
        </section>
      ) : null}

      {/* H14 */}
      <FailureList
        codes={state?.failures ?? []}
        hiddenCodes={hiddenFailureCodes}
        onDismiss={onDismissFailure}
      />

      {room && !room.composition.valid ? (
        <p className="error-banner" role="alert">
          This room has no connected human. Any composition with at least one human is valid; this
          one is not.
        </p>
      ) : null}
    </div>
  );
}
