import { useState } from "react";
import type { RoomSnapshot } from "../../shared/contracts";
import { LATENCY_STAGES, LATENCY_TARGETS, TOTAL_BUDGET_MS } from "../../shared/latency";
import { type Measurement, measured, notExposed } from "../../shared/measurement";
import type { LadderState } from "../audio/DegradationLadder";
import type { SessionMetrics, SessionPhase } from "../session/RoomSession";
import type { SessionEvent } from "../session/SessionEventLog";
import { MeasurementRow, MeasurementValue } from "./MeasurementValue";
import { SubscriptionGraph } from "./SubscriptionGraph";

/**
 * §4.3 protocol inspector. Every figure here goes through `MeasurementValue`,
 * so anything the client cannot observe reads "Not exposed" (H15) rather than
 * a plausible-looking zero.
 */

export interface InspectorProps {
  room: RoomSnapshot;
  viewerId: string;
  phase: SessionPhase;
  metrics: SessionMetrics;
  degradation: LadderState;
  events: readonly SessionEvent[];
  publishing: boolean;
  subscribedIds: readonly string[];
  open: boolean;
  onClose: () => void;
}

type Tab = "signal" | "graph" | "objects" | "latency" | "events";

export function Inspector({
  room,
  viewerId,
  phase,
  metrics,
  degradation,
  events,
  publishing,
  subscribedIds,
  open,
  onClose,
}: InspectorProps) {
  const [tab, setTab] = useState<Tab>("signal");

  return (
    <aside className={`inspector${open ? " inspector--open" : ""}`} aria-label="Protocol inspector">
      <div className="inspector__mobile-heading">
        <h2>Inspector</h2>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </div>

      <div className="inspector__tabs" role="tablist">
        {(
          [
            ["signal", "Signal path"],
            ["graph", "Subscription graph"],
            ["objects", "Objects"],
            ["latency", "Latency"],
            ["events", "Events"],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* §4.3: the fan-out argument, shown rather than asserted. */}
      <div className="inspector__summary">
        <b>
          Uplink <MeasurementValue measurement={metrics.publishedTracks} unit="track out" />
        </b>
        <b>
          Downlink <MeasurementValue measurement={metrics.subscribedTracks} unit="tracks in" />
        </b>
      </div>

      <div className="inspector__body">
        {tab === "signal" ? <Signal room={room} phase={phase} metrics={metrics} /> : null}
        {tab === "graph" ? (
          <SubscriptionGraph
            participants={room.participants}
            routing={room.routing}
            viewerId={viewerId}
            publishing={publishing}
            subscribedIds={subscribedIds}
          />
        ) : null}
        {tab === "objects" ? <Objects metrics={metrics} degradation={degradation} /> : null}
        {tab === "latency" ? <Latency metrics={metrics} /> : null}
        {tab === "events" ? <Events events={events} /> : null}
      </div>
    </aside>
  );
}

function Signal({
  room,
  phase,
  metrics,
}: {
  room: RoomSnapshot;
  phase: SessionPhase;
  metrics: SessionMetrics;
}) {
  const live = phase.name === "live";
  return (
    <div className="inspector-signal">
      <ol>
        <li className={live ? "live" : ""}>
          <i className="coral" /> Microphone / AI voice <small>Opus, 48 kHz, 20 ms frames</small>
        </li>
        <li className={live ? "live" : ""}>
          <i /> Media over QUIC track <small>audio/&lt;participant-id&gt;</small>
        </li>
        <li className={live ? "live" : ""}>
          <i /> WebTransport session <small>{describePhase(phase)}</small>
        </li>
        <li className={live ? "live" : ""}>
          <i /> HTTP/3 over QUIC <small>no WebSocket or WebRTC audio path exists</small>
        </li>
        <li className={live ? "live" : ""}>
          <i /> MoQ relay <small>{room.transport.reason}</small>
        </li>
      </ol>

      <dl className="inspector-facts">
        <div>
          <dt>Negotiated draft</dt>
          <dd>
            {room.transport.availability === "available" ? (
              `draft-${room.transport.draft}`
            ) : (
              <MeasurementValue
                measurement={notExposed<string>(
                  "No MOQT session has been negotiated, so there is no negotiated draft to report.",
                )}
              />
            )}
          </dd>
        </div>
        <div>
          <dt>Relay endpoint</dt>
          <dd>
            <code>{room.transport.endpoint}</code>
          </dd>
        </div>
        <div>
          <dt>Discovery</dt>
          {/* FR7: say which mechanism actually carried discovery. */}
          <dd>{describeDiscovery(room.transport.discovery)}</dd>
        </div>
        <div>
          <dt>Inbound routing</dt>
          <dd>
            {room.transport.routingEnforcement === "enforced"
              ? "Enforced — subscriber credentials are scoped per track"
              : "Cooperative — the AI unsubscribes on request"}
          </dd>
        </div>
        <MeasurementRow label="Session ready" measurement={metrics.transportReadyMs} unit="ms" />
        <MeasurementRow label="First audio" measurement={metrics.firstAudioMs} unit="ms" />
        <MeasurementRow label="Reconnects" measurement={metrics.reconnects} />
      </dl>
    </div>
  );
}

function Objects({ metrics, degradation }: { metrics: SessionMetrics; degradation: LadderState }) {
  return (
    <dl className="object-list">
      <MeasurementRow
        label="Object rate"
        measurement={metrics.objectsPerSecond}
        format={(value) => value.toFixed(1)}
        unit="obj/s"
      />
      <MeasurementRow label="Late drops" measurement={metrics.lateDrops} />
      <MeasurementRow label="Cancelled on barge-in" measurement={metrics.cancelledDrops} />
      <MeasurementRow
        label="Worst buffer"
        measurement={metrics.worstBufferMs}
        format={(value) => String(Math.round(value))}
        unit="ms"
      />
      <MeasurementRow
        label="Opus DTX"
        measurement={metrics.dtxEnabled}
        format={(value) => (value ? "Enabled" : "Not supported by this encoder")}
      />
      <div className="measurement-row">
        <dt>Capacity state</dt>
        <dd>
          {degradation.step === 0
            ? "Within measured capacity"
            : `Degradation step ${degradation.step} — ${degradation.announcement ?? ""}`}
        </dd>
      </div>
      <div className="measurement-row">
        <dt>Decoders released</dt>
        <dd>{degradation.releasedDecoders.length}</dd>
      </div>
    </dl>
  );
}

function Latency({ metrics }: { metrics: SessionMetrics }) {
  return (
    <div className="latency-view">
      <table>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Budget</th>
            <th>Measured</th>
          </tr>
        </thead>
        <tbody>
          {LATENCY_STAGES.map((stage) => (
            <tr key={stage.id}>
              <th scope="row">{stage.label}</th>
              <td>{stage.budgetMs} ms</td>
              <td>
                <MeasurementValue
                  measurement={measuredStage(stage.id, stage.note, metrics)}
                  format={(value) => String(Math.round(value))}
                  unit="ms"
                />
              </td>
            </tr>
          ))}
          <tr className="latency-total">
            <th scope="row">Total</th>
            <td>≈{TOTAL_BUDGET_MS} ms</td>
            <td>
              <MeasurementValue
                measurement={notExposed<number>(
                  "End-to-end latency needs the acoustic loopback method in §9.4; a single client cannot observe it.",
                )}
              />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="latency-note">
        Target p50 under {LATENCY_TARGETS.p50Ms} ms and p95 under {LATENCY_TARGETS.p95Ms} ms at the
        reference composition ({LATENCY_TARGETS.composition}). Figures without a composition are
        meaningless once membership is open.
      </p>
      <dl className="object-list">
        <MeasurementRow
          label="Last barge-in"
          measurement={metrics.lastBargeInMs}
          format={(value) => String(Math.round(value))}
          unit="ms"
        />
        <MeasurementRow
          label="Last routing change"
          measurement={metrics.lastRoutingChangeMs}
          format={(value) => String(Math.round(value))}
          unit="ms"
        />
      </dl>
    </div>
  );
}

function measuredStage(
  stageId: string,
  note: string,
  metrics: SessionMetrics,
): Measurement<number> {
  switch (stageId) {
    case "network":
      return metrics.transportRttMs.exposed
        ? measured(metrics.transportRttMs.value)
        : notExposed(note);
    case "jitter":
      return metrics.worstBufferMs;
    case "decode":
      return metrics.outputLatencyMs;
    default:
      return notExposed(note);
  }
}

function Events({ events }: { events: readonly SessionEvent[] }) {
  return (
    <section className="event-stream">
      <div className="section-heading">
        <h3>Event stream</h3>
        <span>{events.length} retained</span>
      </div>
      <ol>
        {events.map((event) => (
          <li key={event.id} className={event.simulated ? "event--simulated" : ""}>
            <time>{new Date(event.at).toLocaleTimeString("en-GB", { hour12: false })}</time>
            <b>[{event.kind}]</b>
            <span>{event.detail}</span>
            {event.simulated ? <em>simulated</em> : null}
          </li>
        ))}
        {events.length === 0 ? <li className="empty">No events recorded yet.</li> : null}
      </ol>
    </section>
  );
}

function describePhase(phase: SessionPhase): string {
  switch (phase.name) {
    case "live":
      return "Connected";
    case "connecting_transport":
      return "Connecting";
    case "reconnecting":
      return `Reconnecting, attempt ${phase.attempt}`;
    case "blocked":
      return "Blocked before publishing";
    case "terminal":
      return "Failed — retry required";
    case "left":
      return "Closed";
    default:
      return "Not started";
  }
}

function describeDiscovery(mechanism: RoomSnapshot["transport"]["discovery"]): string {
  switch (mechanism) {
    case "subscribe_namespace":
      return "SUBSCRIBE_NAMESPACE over MoQ";
    case "control_channel":
      return "Room service control channel — not over MoQ";
    default:
      return "Not determined; Gate 1 has not recorded the endpoint's capability";
  }
}
