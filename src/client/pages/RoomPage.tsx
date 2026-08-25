import { useCallback, useMemo, useRef, useState } from "react";
import type { Participant } from "../../shared/contracts";
import { notExposed } from "../../shared/measurement";
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

export function RoomPage({ code, navigate }: { code: string; navigate: (path: string) => void }) {
  const [stored] = useState<StoredSession | null>(() => loadSession(code));
  const presenterMode = sessionStorage.getItem(`real-fabric:presenter:${code}`) === "true";
  const { state, session, reclaimed, error, startPublishing, retry, leave } = useRoomSession(
    stored,
    presenterMode,
  );
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const runner = useRef(new DemoRunner());
  const [runnerTick, setRunnerTick] = useState(0);
  const prominentIds = useRef<string[]>([]);

  const room = state?.room ?? null;
  const viewerId = stored?.participantId ?? "";

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
      level={participant.id === viewerId ? (state?.micLevel ?? 0) : 0}
      speaking={participant.id === viewerId ? (state?.speaking ?? false) : false}
      onRouting={changeRouting}
      onAddressDown={(aiId) => void session?.address(aiId)}
      onAddressUp={(aiId) => void session?.endTurn(aiId)}
    />
  );

  return (
    <main className="room-page">
      <header className="room-topbar">
        <Brand />
        <span>
          Room <b>{code}</b>
        </span>
        {/* H4: stated in the room as well as before joining. */}
        <span className="headphones headphones--small">⌁ Headphones required</span>
        <button
          className="button button--compact"
          type="button"
          onClick={() => void navigator.clipboard.writeText(`${location.origin}/room/${code}`)}
        >
          Copy invite
        </button>
        {state?.publishing ? null : (
          <button
            className="button button--compact button--primary"
            disabled={state?.capture.name === "starting"}
            type="button"
            onClick={() => void startPublishing()}
          >
            {state?.capture.name === "starting" ? "Starting microphone…" : "Start microphone"}
          </button>
        )}
        <button
          className="button button--compact button--danger"
          type="button"
          onClick={() => {
            void leave().then(() => {
              clearSession(code);
              navigate("/");
            });
          }}
        >
          Leave room
        </button>
      </header>

      {/* H3 */}
      <PinnedConfigBanner />
      <div className="mobile-warning" role="status">
        <b>!</b> Desktop Chrome required for live audio
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

      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}

      {/* H7: the engaged degradation step is named, never silent. */}
      {state?.degradation.announcement ? (
        <p className="degradation-banner" role="status">
          <b>Capacity:</b> {state.degradation.announcement}
        </p>
      ) : null}

      {/* §11.3: listen-only is a named mode, not a microphone button that
          silently does nothing. The retry is offered where the reason is given. */}
      {state?.capture.name === "listen_only" ? (
        <p className="degradation-banner" role="status">
          <b>Listen-only:</b> {state.capture.reason} Listening and the inspector are unaffected.{" "}
          <button type="button" onClick={() => void startPublishing()}>
            Try the microphone again
          </button>
        </p>
      ) : null}
      {state?.capture.name === "listen_only_device_available" ? (
        <p className="degradation-banner" role="status">
          <b>Microphone available:</b> {state.capture.reason}{" "}
          <button type="button" onClick={() => void startPublishing()}>
            Start microphone
          </button>
        </p>
      ) : null}

      {/* H14 */}
      <FailureList
        codes={state?.failures ?? []}
        onDismiss={(failureCode) => session?.clearFailure(failureCode)}
      />

      {room && !room.composition.valid ? (
        <p className="error-banner" role="alert">
          This room has no connected human. Any composition with at least one human is valid; this
          one is not.
        </p>
      ) : null}

      <div className="room-layout">
        <section
          className={`participant-surface participant-surface--${layout.layout}`}
          aria-label="Room participants"
        >
          <p className="mobile-readonly">▣ Read-only room view</p>
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

      <button
        className="mobile-inspector-button"
        type="button"
        onClick={() => setInspectorOpen(true)}
      >
        Open inspector
      </button>
    </main>
  );
}
