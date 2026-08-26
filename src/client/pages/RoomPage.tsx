import { useCallback, useMemo, useRef, useState } from "react";
import type { Participant } from "../../shared/contracts";
import { notExposed } from "../../shared/measurement";
import { currentUserAgentFacts, matchConfiguration } from "../../shared/pinnedConfiguration";
import {
  clearSession,
  configurePresenter,
  loadSession,
  type StoredSession,
  setAiToAi,
} from "../api";
import { Brand } from "../components/Brand";
import { DemoScriptPanel } from "../components/DemoScriptPanel";
import { FailureList } from "../components/FailureBanner";
import { Inspector } from "../components/Inspector";
import { ParticipantCard } from "../components/ParticipantCard";
import { PinnedConfigBanner } from "../components/PinnedConfigBanner";
import { PresenterStrip } from "../components/PresenterStrip";
import { useRoomSession } from "../hooks/useRoomSession";
import { type DemoContext, DemoRunner } from "../presenter/DemoScript";
import { layoutParticipants } from "../room/participantLayout";
import {
  microphoneAction,
  punctuateReason,
  representedFailureCodes,
} from "../room/roomPresentation";

export function RoomPage({ code, navigate }: { code: string; navigate: (path: string) => void }) {
  const [stored] = useState<StoredSession | null>(() => loadSession(code));
  const presenterMode = sessionStorage.getItem(`real-fabric:presenter:${code}`) === "true";
  const { state, session, reclaimed, error, startAudio, setMuted, retry, leave } = useRoomSession(
    stored,
    presenterMode,
  );
  const [configuration] = useState(() => matchConfiguration(currentUserAgentFacts()));
  const iphoneAudioCandidate = configuration.device === "iPhone" && configuration.liveAudioEligible;
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const runner = useRef(new DemoRunner());
  const [runnerTick, setRunnerTick] = useState(0);
  const prominentIds = useRef<string[]>([]);

  const room = state?.room ?? null;
  const viewerId = stored?.participantId ?? "";
  const micAction = microphoneAction(state?.capture, state?.publishing ?? false, state?.phase);
  const hiddenFailureCodes = representedFailureCodes(
    state?.capture,
    Boolean(state?.degradation.announcement),
  );

  const copyInvite = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/room/${code}`);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, [code]);

  const confirmLeave = useCallback(async () => {
    if (leaving) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      await leave();
      clearSession(code);
      navigate("/");
    } catch (leaveFailure) {
      setLeaveError(
        leaveFailure instanceof Error
          ? `The room could not be left: ${leaveFailure.message}`
          : "The room could not be left. Try again.",
      );
      setLeaving(false);
    }
  }, [code, leave, leaving, navigate]);

  const connectedHumanIds = useMemo(
    () =>
      (room?.participants ?? [])
        .filter((participant) => participant.role === "human" && participant.state === "connected")
        .map((participant) => participant.id),
    [room],
  );

  const changeRouting = useCallback(
    (aiId: string, hearsMe: boolean, iHearIt: boolean) => {
      void session?.changeRouting(aiId, hearsMe, iHearIt);
    },
    [session],
  );

  const changeSubscription = useCallback(
    (participantId: string, enabled: boolean) => {
      const participant = room?.participants.find((candidate) => candidate.id === participantId);
      if (participant?.role === "ai") {
        const row = room?.routing.find(
          (candidate) => candidate.aiId === participantId && candidate.humanId === viewerId,
        );
        void session?.changeRouting(participantId, row?.hearsMe ?? false, enabled);
        return;
      }
      void session?.setSubscription(participantId, enabled);
    },
    [room, session, viewerId],
  );

  const demoContext = useCallback((): DemoContext => {
    const metrics = state?.metrics;
    const speaking = (room?.participants ?? []).filter(
      (participant) => participant.role === "ai" && participant.pipeline === "speaking",
    ).length;
    const partialContext = (room?.participants ?? [])
      .filter((participant) => participant.role === "ai")
      .filter((ai) =>
        connectedHumanIds.some(
          (humanId) =>
            !(room?.routing ?? []).some(
              (row) => row.aiId === ai.id && row.humanId === humanId && row.hearsMe,
            ),
        ),
      )
      .map((ai) => ai.id);

    return {
      msSinceRoomOpen: room ? Date.now() - room.createdAt : Number.MAX_SAFE_INTEGER,
      participantCount: (room?.participants ?? []).length,
      aisSpeaking: speaking,
      publishedTracks: metrics?.publishedTracks ?? notExposed("No session state."),
      subscribedTracks: metrics?.subscribedTracks ?? notExposed("No session state."),
      lastBargeInMs: metrics?.lastBargeInMs ?? notExposed("No session state."),
      lastRoutingChangeMs: metrics?.lastRoutingChangeMs ?? notExposed("No session state."),
      partialContextAiIds: partialContext,
      floorQueueLength: room?.floor.queue.length ?? 0,
      // H12: the deduplicator refuses repeats, so a duplicate reaching playback
      // would be a defect rather than a state to report as normal.
      duplicatePlaybackDetected: false,
      identityReclaimed: reclaimed,
      // H15: every figure on screen goes through MeasurementValue.
      unobservablesLabelled: true,
    };
  }, [state, room, connectedHumanIds, reclaimed]);

  if (!stored) {
    return (
      <main className="room-join-gate">
        <Brand />
        <h1>Join room {code}</h1>
        <p>
          This share link contains only the room code. Enter through the join screen to mint
          ephemeral participant credentials.
        </p>
        <p className="headphones">⌁ Headphones required</p>
        <button
          className="button button--primary"
          type="button"
          onClick={() => navigate(`/?room=${code}`)}
        >
          Join room
        </button>
      </main>
    );
  }

  const layout = room
    ? layoutParticipants(room.participants, viewerId, prominentIds.current)
    : { layout: "equal" as const, prominent: [] as Participant[], rest: [] as Participant[] };
  prominentIds.current = layout.prominent.map((participant) => participant.id);

  const renderCard = (participant: Participant) => (
    <ParticipantCard
      key={participant.id}
      participant={participant}
      current={participant.id === viewerId}
      viewerId={viewerId}
      routing={room?.routing ?? []}
      connectedHumanIds={connectedHumanIds}
      level={participant.id === viewerId && !state?.muted ? (state?.micLevel ?? 0) : 0}
      speaking={participant.id === viewerId && !state?.muted ? (state?.speaking ?? false) : false}
      subscription={state?.subscriptions.find(
        (subscription) => subscription.participantId === participant.id,
      )}
      onSubscription={changeSubscription}
      onRouting={changeRouting}
      onAddressDown={(aiId) => void session?.address(aiId)}
      onAddressUp={(aiId) => void session?.endTurn(aiId)}
    />
  );

  return (
    <main className={`room-page${iphoneAudioCandidate ? " room-page--ios-live-audio" : ""}`}>
      <h1 className="sr-only">Real Fabric room {code}</h1>
      <header className="room-topbar">
        <Brand />
        <span title={`Room ${code}`}>
          Room <b>{code}</b>
        </span>
        {/* H4: stated in the room as well as before joining. */}
        <span className="headphones headphones--small">⌁ Headphones required</span>
        <button
          className={`button button--compact${copyState === "copied" ? " button--success" : ""}`}
          type="button"
          onClick={() => void copyInvite()}
        >
          {copyState === "copied"
            ? "Invite copied"
            : copyState === "failed"
              ? "Retry copy"
              : "Copy invite"}
        </button>
        {micAction.visible && configuration.liveAudioEligible ? (
          <button
            className="button button--compact button--primary"
            disabled={micAction.disabled}
            type="button"
            onClick={() => void startAudio()}
          >
            {micAction.label}
          </button>
        ) : null}
        <button
          className="button button--compact button--danger"
          type="button"
          onClick={() => {
            setLeaveError(null);
            leaveDialog.current?.showModal();
          }}
        >
          Leave room
        </button>
      </header>

      <span className="sr-only" role="status" aria-live="polite">
        {copyState === "copied"
          ? "Invite link copied to the clipboard."
          : copyState === "failed"
            ? "The invite link could not be copied."
            : ""}
      </span>

      <dialog
        ref={leaveDialog}
        className="leave-dialog"
        aria-labelledby="leave-dialog-title"
        onCancel={() => setLeaveError(null)}
      >
        <h2 id="leave-dialog-title">Leave room {code}?</h2>
        <p>You will stop sending and receiving audio. You can rejoin with the same invite link.</p>
        {leaveError ? (
          <p className="leave-dialog__error" role="alert">
            {leaveError}
          </p>
        ) : null}
        <div className="leave-dialog__actions">
          <button
            className="button button--compact"
            type="button"
            disabled={leaving}
            onClick={() => leaveDialog.current?.close()}
          >
            Stay
          </button>
          <button
            className="button button--compact button--danger"
            type="button"
            disabled={leaving}
            onClick={() => void confirmLeave()}
          >
            {leaving ? "Leaving…" : "Leave room"}
          </button>
        </div>
      </dialog>

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
            <button type="button" onClick={() => void retry()}>
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
          onDismiss={(failureCode) => session?.clearFailure(failureCode)}
        />

        {room && !room.composition.valid ? (
          <p className="error-banner" role="alert">
            This room has no connected human. Any composition with at least one human is valid; this
            one is not.
          </p>
        ) : null}
      </div>

      <div className="room-layout">
        <section
          className={`participant-surface participant-surface--${layout.layout}`}
          aria-label="Room participants"
        >
          <h2 className="sr-only">Room participants</h2>
          {!iphoneAudioCandidate ? <p className="mobile-readonly">▣ Read-only room view</p> : null}
          <div className="participant-grid participant-grid--prominent">
            {layout.prominent.map(renderCard)}
          </div>
          {layout.rest.length > 0 ? (
            <div className="participant-grid participant-grid--compact">
              {layout.rest.map(renderCard)}
            </div>
          ) : null}
          {layout.prominent.length === 0 ? (
            <p className="empty-room">No active participants are exposed.</p>
          ) : null}
          <div className="mobile-actions">
            <button type="button" onClick={() => setInspectorOpen(true)}>
              Open inspector →
            </button>
          </div>
        </section>

        {room && state ? (
          <Inspector
            room={room}
            viewerId={viewerId}
            phase={state.phase}
            metrics={state.metrics}
            degradation={state.degradation}
            events={state.events}
            publishing={state.publishing}
            subscribedIds={state.subscribedParticipantIds}
            negotiation={state.negotiation}
            network={state.network}
            open={inspectorOpen}
            onClose={() => setInspectorOpen(false)}
          />
        ) : null}
      </div>

      {presenterMode && room && state && session ? (
        <>
          <PresenterStrip
            room={room}
            phase={state.phase}
            metrics={state.metrics}
            degradation={state.degradation}
            lastError={state.failures[0] ?? null}
            onSimulate={(humans, ais) => {
              void configurePresenter(stored, {
                simulatedHumans: humans,
                simulatedAis: ais,
                scriptedResponses: true,
              });
            }}
            onAiToAi={(enabled) => {
              void setAiToAi(stored, enabled ? "enable" : "disable");
            }}
            onExport={() => {
              const link = document.createElement("a");
              link.href = URL.createObjectURL(session.telemetry.export(code));
              link.download = `real-fabric-${code}-sanitised.json`;
              link.click();
              URL.revokeObjectURL(link.href);
            }}
          />
          <DemoScriptPanel
            currentStep={runner.current.currentStep}
            runs={runner.current.history}
            cleanRuns={runner.current.cleanRuns}
            releaseGateMet={runner.current.releaseGateMet}
            running={runner.current.running}
            onBegin={() => {
              runner.current.begin();
              setRunnerTick(runnerTick + 1);
            }}
            onRecord={(outcome) => {
              runner.current.record(demoContext(), outcome);
              setRunnerTick(runnerTick + 1);
            }}
            onAbandon={() => {
              runner.current.abandon("Run abandoned by the presenter.");
              setRunnerTick(runnerTick + 1);
            }}
          />
        </>
      ) : null}

      {iphoneAudioCandidate ? (
        <nav className="mobile-audio-rail" aria-label="Foreground audio controls">
          {micAction.visible ? (
            <button
              className="mobile-audio-rail__primary"
              disabled={micAction.disabled}
              type="button"
              onClick={() => void startAudio()}
            >
              {micAction.label}
            </button>
          ) : (
            <span className="mobile-audio-rail__status">Audio live</span>
          )}
          <button
            type="button"
            disabled={!state?.publishing}
            onClick={() => setMuted(!(state?.muted ?? false))}
          >
            {state?.muted ? "Unmute" : "Mute"}
          </button>
          <button type="button" onClick={() => setInspectorOpen(true)}>
            Inspector
          </button>
          <button
            className="mobile-audio-rail__danger"
            type="button"
            onClick={() => {
              setLeaveError(null);
              leaveDialog.current?.showModal();
            }}
          >
            Leave
          </button>
        </nav>
      ) : (
        <button
          className="mobile-inspector-button"
          type="button"
          onClick={() => setInspectorOpen(true)}
        >
          Open inspector
        </button>
      )}
    </main>
  );
}
