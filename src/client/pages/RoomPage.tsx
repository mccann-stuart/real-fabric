import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Participant } from "../../shared/contracts";
import { notExposed } from "../../shared/measurement";
import type { ConfigurationMatch } from "../../shared/pinnedConfiguration";
import { clearSession, configurePresenter, loadSession, setAiToAi } from "../api";
import { Brand } from "../components/Brand";
import { DemoScriptPanel } from "../components/DemoScriptPanel";
import { Inspector } from "../components/Inspector";
import { LeaveRoomDialog } from "../components/LeaveRoomDialog";
import { ParticipantCard } from "../components/ParticipantCard";
import { PresenterStrip } from "../components/PresenterStrip";
import { RoomStatusStack } from "../components/RoomStatusStack";
import { RoomTopBar } from "../components/RoomTopBar";
import { useRoomSession } from "../hooks/useRoomSession";
import { DemoRunner } from "../presenter/DemoScript";
import { layoutParticipants } from "../room/participantLayout";
import { microphoneAction, representedFailureCodes } from "../room/roomPresentation";
import type { TrackSubscriptionState } from "../session/RoomSession";

const COPY_FEEDBACK_DURATION_MS = 2_500;

export function RoomPage({
  code,
  configuration,
  navigate,
}: {
  code: string;
  configuration: ConfigurationMatch;
  navigate: (path: string) => void;
}) {
  const [stored] = useState(() => loadSession(code));
  const presenterMode = sessionStorage.getItem(`real-fabric:presenter:${code}`) === "true";
  const { state, session, reclaimed, error, startAudio, setMuted, retry, leave } = useRoomSession(
    stored,
    presenterMode,
  );
  const iphoneAudioCandidate = configuration.device === "iPhone" && configuration.liveAudioEligible;
  const iphoneCapabilitiesChecking =
    configuration.device === "iPhone" && configuration.status === "checking";
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyAttempt = useRef(0);
  const copyFeedbackTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
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

  useEffect(
    () => () => {
      copyAttempt.current += 1;
      if (copyFeedbackTimer.current !== null) {
        globalThis.clearTimeout(copyFeedbackTimer.current);
        copyFeedbackTimer.current = null;
      }
    },
    [],
  );

  const copyInvite = useCallback(async () => {
    const attempt = copyAttempt.current + 1;
    copyAttempt.current = attempt;
    if (copyFeedbackTimer.current !== null) {
      globalThis.clearTimeout(copyFeedbackTimer.current);
      copyFeedbackTimer.current = null;
    }

    let outcome: "copied" | "failed";
    try {
      await navigator.clipboard.writeText(`${location.origin}/room/${code}`);
      outcome = "copied";
    } catch {
      outcome = "failed";
    }

    // A slower earlier clipboard request must not replace newer feedback.
    if (copyAttempt.current !== attempt) return;
    setCopyState(outcome);
    copyFeedbackTimer.current = globalThis.setTimeout(() => {
      if (copyAttempt.current !== attempt) return;
      setCopyState("idle");
      copyFeedbackTimer.current = null;
    }, COPY_FEEDBACK_DURATION_MS);
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

  const layout = useMemo(
    () =>
      room
        ? layoutParticipants(room.participants, viewerId, prominentIds.current)
        : {
            layout: "equal" as const,
            prominent: [] as Participant[],
            rest: [] as Participant[],
          },
    [room, viewerId],
  );

  useEffect(() => {
    prominentIds.current = layout.prominent.map((participant) => participant.id);
  }, [layout.prominent]);

  const subscriptionMap = useMemo(() => {
    const map = new Map<string, TrackSubscriptionState>();
    const subscriptions = state?.subscriptions;
    if (subscriptions) {
      for (let index = 0; index < subscriptions.length; index += 1) {
        const item = subscriptions[index];
        if (item) map.set(item.participantId, item);
      }
    }
    return map;
  }, [state?.subscriptions]);

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

  const handleAddressDown = useCallback(
    (aiId: string) => {
      void session?.address(aiId);
    },
    [session],
  );

  const handleAddressUp = useCallback(
    (aiId: string) => {
      void session?.endTurn(aiId);
    },
    [session],
  );

  const demoContext = useCallback(() => {
    const metrics = state?.metrics;
    const participants = room?.participants ?? [];
    const routing = room?.routing ?? [];

    const speaking = participants.filter(
      (participant) => participant.role === "ai" && participant.pipeline === "speaking",
    ).length;

    // Performance optimization (⚡ Bolt): Index (aiId, humanId) pairs where hearsMe is true into a Set
    // to evaluate partial context in O(N) rather than nested array methods O(N_ai * N_human * N_routing).
    const hearingPairs = new Set<string>();
    for (let i = 0; i < routing.length; i += 1) {
      const row = routing[i];
      if (row?.hearsMe) {
        hearingPairs.add(`${row.aiId}:${row.humanId}`);
      }
    }

    const partialContext = participants
      .filter((participant) => participant.role === "ai")
      .filter((ai) => connectedHumanIds.some((humanId) => !hearingPairs.has(`${ai.id}:${humanId}`)))
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
      subscription={subscriptionMap.get(participant.id)}
      onSubscription={changeSubscription}
      onRouting={changeRouting}
      onAddressDown={handleAddressDown}
      onAddressUp={handleAddressUp}
    />
  );

  return (
    <main className={`room-page${iphoneAudioCandidate ? " room-page--ios-live-audio" : ""}`}>
      <h1 className="sr-only">Real Fabric room {code}</h1>
      <RoomTopBar
        code={code}
        copyState={copyState}
        onCopyInvite={() => void copyInvite()}
        micAction={micAction}
        liveAudioEligible={configuration.liveAudioEligible}
        onStartAudio={() => void startAudio()}
        onOpenLeaveDialog={() => {
          setLeaveError(null);
          leaveDialog.current?.showModal();
        }}
      />

      <LeaveRoomDialog
        dialogRef={leaveDialog}
        code={code}
        leaveError={leaveError}
        leaving={leaving}
        onCancel={() => setLeaveError(null)}
        onConfirmLeave={() => void confirmLeave()}
      />

      <div className="room-layout">
        <section
          className={`participant-surface participant-surface--${layout.layout}`}
          aria-label="Room participants"
        >
          <h2 className="sr-only">Room participants</h2>
          {!iphoneAudioCandidate && !iphoneCapabilitiesChecking ? (
            <p className="mobile-readonly">▣ Read-only room view</p>
          ) : null}
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
            <button
              type="button"
              aria-expanded={inspectorOpen}
              aria-controls="inspector-panel"
              onClick={() => setInspectorOpen(true)}
            >
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

      <RoomStatusStack
        configuration={configuration}
        state={state}
        reclaimed={reclaimed}
        error={error}
        iphoneAudioCandidate={iphoneAudioCandidate}
        hiddenFailureCodes={hiddenFailureCodes}
        onRetry={() => void retry()}
        onDismissFailure={(failureCode) => session?.clearFailure(failureCode)}
      />

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
            aria-pressed={state?.muted ?? false}
            onClick={() => setMuted(!(state?.muted ?? false))}
          >
            {state?.muted ? "Unmute" : "Mute"}
          </button>
          <button
            type="button"
            aria-expanded={inspectorOpen}
            aria-controls="inspector-panel"
            onClick={() => setInspectorOpen(true)}
          >
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
          aria-expanded={inspectorOpen}
          aria-controls="inspector-panel"
          onClick={() => setInspectorOpen(true)}
        >
          Open inspector
        </button>
      )}
    </main>
  );
}
