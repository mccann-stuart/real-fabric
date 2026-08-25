import { MAX_SIMULATED_PARTICIPANTS, type RoomSnapshot } from "../../shared/contracts";
import type { LadderState } from "../audio/DegradationLadder";
import type { SessionMetrics, SessionPhase } from "../session/RoomSession";
import { MeasurementValue } from "./MeasurementValue";

/**
 * §4.2 presenter health strip: visible to the presenter only and excluded from
 * screen capture, plus the presenter controls the §12 script needs.
 *
 * `-webkit-user-select` and the capture exclusion are styling concerns; what
 * matters here is that every figure comes from real state and reads
 * "Not exposed" when it cannot be observed.
 */

export interface PresenterStripProps {
  room: RoomSnapshot;
  phase: SessionPhase;
  metrics: SessionMetrics;
  degradation: LadderState;
  lastError: string | null;
  onSimulate: (humans: number, ais: number) => void;
  onAiToAi: (enabled: boolean) => void;
  onExport: () => void;
}

export function PresenterStrip({
  room,
  phase,
  metrics,
  degradation,
  lastError,
  onSimulate,
  onAiToAi,
  onExport,
}: PresenterStripProps) {
  const { simulatedHumans, simulatedAis } = room.presenter;
  return (
    <footer className="presenter-health" data-exclude-from-capture="true">
      <h2>Presenter health</h2>

      <div className="health-item">
        <b>
          <i className={phase.name === "live" ? "green" : "amber"} />
          Transport
        </b>
        <span>{describePhase(phase)}</span>
      </div>
      <div className="health-item">
        <b>
          <i className="green" />
          Participants
        </b>
        <span>
          {room.composition.humans} human, {room.composition.ais} AI
        </span>
      </div>
      <div className="health-item">
        <b>
          <i className={phase.name === "live" ? "green" : "amber"} />
          Subscriptions
        </b>
        <span>
          <MeasurementValue measurement={metrics.subscribedTracks} />
        </span>
      </div>
      <div className="health-item">
        <b>
          <i className={degradation.step === 0 ? "green" : "amber"} />
          Worst buffer
        </b>
        <span>
          <MeasurementValue
            measurement={metrics.worstBufferMs}
            format={(value) => String(Math.round(value))}
            unit="ms"
          />
        </span>
      </div>
      <div className="health-item">
        <b>
          <i className={room.floor.holderId ? "amber" : "green"} />
          AI pipelines
        </b>
        <span>
          {room.floor.holderId ? "1 speaking" : "idle"}
          {room.floor.queue.length > 0 ? `, ${room.floor.queue.length} waiting` : ""}
          {room.presenter.scriptedResponses ? " (scripted)" : ""}
        </span>
      </div>
      <div className="health-item">
        <b>
          <i className={lastError ? "amber" : "green"} />
          Last error
        </b>
        <span>{lastError ?? "None"}</span>
      </div>

      <div className="presenter-controls">
        {/* H11: a configurable number of labelled simulated participants. */}
        <label>
          Simulated humans
          <input
            type="number"
            min={0}
            max={MAX_SIMULATED_PARTICIPANTS}
            value={simulatedHumans}
            onChange={(event) => onSimulate(clamp(Number(event.target.value)), simulatedAis)}
          />
        </label>
        <label>
          Simulated AIs
          <input
            type="number"
            min={0}
            max={MAX_SIMULATED_PARTICIPANTS}
            value={simulatedAis}
            onChange={(event) => onSimulate(simulatedHumans, clamp(Number(event.target.value)))}
          />
        </label>
        {/* H10: off by default, and the counter is visible once enabled. */}
        <label className="toggle-row">
          <span>AI hears AI</span>
          <input
            type="checkbox"
            checked={room.aiToAi.enabled}
            onChange={(event) => onAiToAi(event.target.checked)}
          />
          <i aria-hidden="true" />
        </label>
        {room.aiToAi.enabled ? (
          <span className={`turn-counter${room.aiToAi.cappedAt ? " turn-counter--capped" : ""}`}>
            AI-to-AI turns {room.aiToAi.consecutiveTurns} / {room.aiToAi.turnCap}
            {room.aiToAi.cappedAt ? " — cap reached, exchange stopped" : ""}
          </span>
        ) : null}
        <button type="button" onClick={onExport}>
          Export sanitised JSON
        </button>
      </div>
    </footer>
  );
}

function describePhase(phase: SessionPhase): string {
  switch (phase.name) {
    case "live":
      return "Live";
    case "connecting_transport":
      return "Connecting";
    case "reconnecting":
      return `Reconnecting (attempt ${phase.attempt})`;
    case "blocked":
      return `Blocked — ${phase.failure}`;
    case "terminal":
      return `Failed — ${phase.failure}`;
    case "left":
      return "Closed";
    default:
      return "Not started";
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_SIMULATED_PARTICIPANTS, Math.max(0, Math.trunc(value)));
}
