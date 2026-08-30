import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import {
  BARGE_IN_BUDGET_MS,
  ROUTING_CHANGE_BUDGET_MS,
  type RoomSnapshot,
} from "../../shared/contracts";
import { LATENCY_STAGES, LATENCY_TARGETS, TOTAL_BUDGET_MS } from "../../shared/latency";
import { type Measurement, measured, notExposed } from "../../shared/measurement";
import { MAXIMUM_BUFFER_MS } from "../audio/AdaptiveJitterBuffer";
import { DEFAULT_BITRATE } from "../audio/CaptureController";
import type { LadderState } from "../audio/DegradationLadder";
import { MAXIMUM_CORRECTION_RATIO } from "../audio/DriftEstimator";
import { AUDIO_FRAME_DURATION_MS, AUDIO_OBJECT_HEADER_BYTES } from "../audio/frame";
import type { SessionMetrics, SessionPhase } from "../session/RoomSession";
import type { SessionEvent } from "../session/SessionEventLog";
import type { MoqNegotiation } from "../transport/MoqTransportAdapter";
import type { ProbeResult } from "../transport/NetworkProbe";
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
  /** §11.2: the validated handshake, or null before one has completed. */
  negotiation: MoqNegotiation | null;
  network: ProbeResult;
  open: boolean;
  onClose: () => void;
}

type Tab = "signal" | "graph" | "objects" | "latency" | "events";

const INSPECTOR_TABS = [
  ["signal", "Signal", "Signal path"],
  ["graph", "Graph", "Subscription graph"],
  ["objects", "Objects", "Objects"],
  ["latency", "Latency", "Latency"],
  ["events", "Events", "Events"],
] as const satisfies ReadonlyArray<readonly [Tab, string, string]>;

const OBJECTS_PER_SECOND_PER_ACTIVE_SPEAKER = 1_000 / AUDIO_FRAME_DURATION_MS;
const DEFAULT_OBJECT_BYTES =
  DEFAULT_BITRATE / 8 / OBJECTS_PER_SECOND_PER_ACTIVE_SPEAKER + AUDIO_OBJECT_HEADER_BYTES;
const MAXIMUM_DRIFT_PPM = Math.round((MAXIMUM_CORRECTION_RATIO - 1) * 1_000_000);
const SESSION_READY_BUDGET_MS = 5_000;

export function Inspector({
  room,
  viewerId,
  phase,
  metrics,
  degradation,
  events,
  publishing,
  subscribedIds,
  negotiation,
  network,
  open,
  onClose,
}: InspectorProps) {
  const [tab, setTab] = useState<Tab>("signal");

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % INSPECTOR_TABS.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = INSPECTOR_TABS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = INSPECTOR_TABS[nextIndex];
    if (!nextTab) return;
    setTab(nextTab[0]);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")
      .item(nextIndex)
      .focus();
  };

  return (
    <aside className={`inspector${open ? " inspector--open" : ""}`} aria-label="Protocol inspector">
      <div className="inspector__mobile-heading">
        <h2>Inspector</h2>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </div>

      <div className="inspector__tabs" role="tablist">
        {INSPECTOR_TABS.map(([id, label, accessibleLabel], index) => (
          <button
            key={id}
            id={`inspector-tab-${id}`}
            type="button"
            role="tab"
            aria-label={accessibleLabel}
            aria-controls="inspector-panel"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
            onKeyDown={(event) => moveTabFocus(event, index)}
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

      <div
        id="inspector-panel"
        className="inspector__body"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${tab}`}
      >
        {tab === "signal" ? (
          <Signal
            room={room}
            phase={phase}
            metrics={metrics}
            negotiation={negotiation}
            network={network}
          />
        ) : null}
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
  negotiation,
  network,
}: {
  room: RoomSnapshot;
  phase: SessionPhase;
  metrics: SessionMetrics;
  negotiation: MoqNegotiation | null;
  network: ProbeResult;
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
        {/* §11.2: read from the validated handshake, never from configuration.
            A configured draft is an intention; a negotiated one is a fact. */}
        <div>
          <dt>Negotiated draft</dt>
          <dd>
            {negotiation ? (
              <code>
                draft-{negotiation.negotiatedDraft} ({negotiation.wireVersion})
              </code>
            ) : (
              <MeasurementValue
                measurement={notExposed<string>(
                  "No MOQT setup handshake has completed, so there is no negotiated draft to report.",
                )}
              />
            )}
          </dd>
        </div>
        <div>
          <dt>Relay endpoint</dt>
          <dd>
            <code>{negotiation?.endpointName ?? room.transport.endpoint}</code>
          </dd>
        </div>
        <div>
          <dt>ALPN offered</dt>
          <dd>
            {negotiation ? (
              <code>{negotiation.alpnOffered.join(", ")}</code>
            ) : (
              <MeasurementValue
                measurement={notExposed<string>("No session has been attempted yet.")}
              />
            )}
          </dd>
        </div>
        <div>
          <dt>WebTransport reliability</dt>
          <dd>
            {negotiation?.transportReliability ?? "Not exposed — no session has completed setup"}
          </dd>
        </div>
        <div>
          <dt>Congestion control</dt>
          <dd>
            {negotiation?.congestionControl ?? "Not exposed — no session has completed setup"}
          </dd>
        </div>
        <div>
          <dt>SERVER_SETUP</dt>
          <dd>
            {negotiation ? (
              <code>
                {negotiation.serverSetup.length === 0
                  ? "validated, no parameters"
                  : negotiation.serverSetup
                      .map((parameter) => `${parameter.name}=${parameter.value}`)
                      .join(" · ")}
              </code>
            ) : (
              <MeasurementValue
                measurement={notExposed<string>("No SERVER_SETUP has been received.")}
              />
            )}
          </dd>
        </div>
        {/* Gate 1 exit. Configured and attempted is not the same as traced. */}
        <div>
          <dt>Gate 1 trace</dt>
          <dd>
            {room.transport.traceVerified
              ? "Recorded — a browser-to-relay trace has verified this endpoint"
              : room.transport.availability === "available"
                ? "Not recorded — transport is attempted live but not yet claimed as verified"
                : "Not recorded — transport is blocked before a live attempt"}
          </dd>
        </div>
        <div>
          <dt>HTTP/3 reachability</dt>
          <dd>{network.detail}</dd>
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
    <div className="comparison-view">
      <ComparisonTable caption="Object delivery">
        <ComparisonRow
          label="Published objects"
          budget="Reported · no gate"
          measurement={metrics.publishedObjects}
        />
        <ComparisonRow
          label="Inbound objects"
          budget="Reported · no gate"
          measurement={metrics.subscribedObjects}
        />
        <ComparisonRow
          label="Inbound object rate"
          budget={`≈${OBJECTS_PER_SECOND_PER_ACTIVE_SPEAKER} obj/s × active speakers`}
          measurement={metrics.objectsPerSecond}
          format={(value) => value.toFixed(1)}
          unit="obj/s"
        />
        <ComparisonRow
          label="Mean object size"
          budget={`≈${DEFAULT_OBJECT_BYTES} B at 32 kbit/s`}
          measurement={metrics.meanObjectBytes}
          format={(value) => String(Math.round(value))}
          unit="B"
        />
        <ComparisonRow
          label="Late-drop rate"
          budget="Reported · no gate"
          measurement={metrics.lateDropRate}
          format={(value) => (value * 100).toFixed(2)}
          unit="%"
        />
        <ComparisonRow
          label="Late drops"
          budget="Reported · no gate"
          measurement={metrics.lateDrops}
        />
        <ComparisonRow
          label="Cancelled on barge-in"
          budget="Reported · no gate"
          measurement={metrics.cancelledDrops}
        />
        {/* §10.5: concealment is counted and shown, not hidden behind the gap. */}
        <ComparisonRow
          label="Concealed frames"
          budget="Reported · no gate"
          measurement={metrics.concealedFrames}
        />
        <ComparisonRow
          label="Comfort noise frames"
          budget="Reported · no gate"
          measurement={metrics.comfortNoiseFrames}
        />
      </ComparisonTable>

      <ComparisonTable caption="Client capacity">
        <ComparisonRow
          label="Worst track buffer"
          budget={`≤${MAXIMUM_BUFFER_MS} ms hard bound`}
          measurement={metrics.worstBufferMs}
          format={(value) => String(Math.round(value))}
          unit="ms"
          withinBudget={(value) => value <= MAXIMUM_BUFFER_MS}
        />
        <ComparisonRow
          label="Aggregate buffer"
          budget="Reported · no gate"
          measurement={metrics.aggregateBufferMs}
          format={(value) => String(Math.round(value))}
          unit="ms"
        />
        <ComparisonRow
          label="Worst clock skew"
          budget={`≤${MAXIMUM_DRIFT_PPM.toLocaleString("en-GB")} ppm correctable`}
          measurement={metrics.worstDriftPpm}
          format={(value) => String(Math.round(value))}
          unit="ppm"
          withinBudget={(value) => value <= MAXIMUM_DRIFT_PPM}
        />
        <ComparisonRow
          label="Active decoders"
          budget="Reported · no gate"
          measurement={metrics.activeDecoders}
        />
        <ComparisonRow
          label="Capacity state"
          budget="Protection inactive"
          measurement={measured(degradation.step)}
          format={(value) => (value === 0 ? "Protection inactive" : `Protection step ${value}`)}
          withinBudget={(value) => value === 0}
        />
        <ComparisonRow
          label="Decoders released"
          budget="0 before degradation"
          measurement={measured(degradation.releasedDecoders.length)}
          withinBudget={(value) => value === 0}
        />
        <ComparisonRow
          label="Opus DTX"
          budget="Required when exposed"
          measurement={metrics.dtxEnabled}
          format={(value) => (value ? "Enabled" : "Not supported by this encoder")}
          withinBudget={(value) => value}
        />
        <ComparisonRow
          label="Capture path"
          budget="Reported · no gate"
          measurement={metrics.capturePath}
          format={(value) =>
            value === "track_processor" ? "MediaStreamTrackProcessor" : "AudioWorklet adapter"
          }
        />
        <ComparisonRow
          label="Audio inputs"
          budget="Reported · no gate"
          measurement={metrics.audioInputs}
        />
        <ComparisonRow
          label="Device changes"
          budget="Reported · no gate"
          measurement={metrics.deviceChanges}
        />
      </ComparisonTable>
      {degradation.announcement ? (
        <p className="comparison-note">{degradation.announcement}</p>
      ) : null}
    </div>
  );
}

function Latency({ metrics }: { metrics: SessionMetrics }) {
  return (
    <div className="comparison-view latency-view">
      <ComparisonTable caption="Per-stream stage latency">
        {LATENCY_STAGES.map((stage) => (
          <ComparisonRow
            key={stage.id}
            label={stage.label}
            budget={`${stage.budgetMs} ms`}
            measurement={measuredStage(stage.id, stage.note, metrics)}
            format={(value) => String(Math.round(value))}
            unit="ms"
            withinBudget={(value) => value <= stage.budgetMs}
          />
        ))}
        <ComparisonRow
          label="Total"
          budget={`≈${TOTAL_BUDGET_MS} ms`}
          measurement={notExposed<number>(
            "End-to-end latency needs the acoustic loopback method in §9.4; a single client cannot observe it.",
          )}
          format={(value) => String(Math.round(value))}
          unit="ms"
          withinBudget={(value) => value <= TOTAL_BUDGET_MS}
          emphasised
        />
      </ComparisonTable>

      <ComparisonTable caption="Interaction and acceptance latency">
        <ComparisonRow
          label="Session ready"
          budget={`≤${SESSION_READY_BUDGET_MS.toLocaleString("en-GB")} ms`}
          measurement={metrics.transportReadyMs}
          format={(value) => String(Math.round(value))}
          unit="ms"
          withinBudget={(value) => value <= SESSION_READY_BUDGET_MS}
        />
        <ComparisonRow
          label="First received audio"
          budget="Reported · no gate"
          measurement={metrics.firstAudioMs}
          format={(value) => String(Math.round(value))}
          unit="ms"
        />
        <ComparisonRow
          label="Last barge-in"
          budget={`≤${BARGE_IN_BUDGET_MS} ms`}
          measurement={metrics.lastBargeInMs}
          format={(value) => String(Math.round(value))}
          unit="ms"
          withinBudget={(value) => value <= BARGE_IN_BUDGET_MS}
        />
        <ComparisonRow
          label="Last routing change"
          budget={`≤${ROUTING_CHANGE_BUDGET_MS} ms`}
          measurement={metrics.lastRoutingChangeMs}
          format={(value) => String(Math.round(value))}
          unit="ms"
          withinBudget={(value) => value <= ROUTING_CHANGE_BUDGET_MS}
        />
        <ComparisonRow
          label="Acoustic loopback p50"
          budget={`<${LATENCY_TARGETS.p50Ms} ms`}
          measurement={notExposed<number>(
            "The §9.4 acoustic loopback measurement has not run in this browser session.",
          )}
          format={(value) => String(Math.round(value))}
          unit="ms"
        />
        <ComparisonRow
          label="Acoustic loopback p95"
          budget={`<${LATENCY_TARGETS.p95Ms} ms`}
          measurement={notExposed<number>(
            "The §9.4 acoustic loopback measurement has not run in this browser session.",
          )}
          format={(value) => String(Math.round(value))}
          unit="ms"
        />
      </ComparisonTable>
      <p className="latency-note">
        Measured values are from this browser session. The p50 and p95 acceptance targets require
        ten acoustic loopback runs at the reference composition ({LATENCY_TARGETS.composition}).
        Figures without a composition are meaningless once membership is open.
      </p>
    </div>
  );
}

function ComparisonTable({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <table className="comparison-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th>Metric</th>
          <th>Budget / target</th>
          <th>Measured</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function ComparisonRow<T>({
  label,
  budget,
  measurement,
  format,
  unit,
  withinBudget,
  emphasised = false,
}: {
  label: string;
  budget: string;
  measurement: Measurement<T>;
  format?: (value: T) => string;
  unit?: string;
  withinBudget?: (value: T) => boolean;
  emphasised?: boolean;
}) {
  const outcome =
    measurement.exposed && withinBudget
      ? withinBudget(measurement.value)
        ? "within"
        : "over"
      : null;
  return (
    <tr className={emphasised ? "comparison-row--emphasised" : undefined}>
      <th scope="row">{label}</th>
      <td>{budget}</td>
      <td>
        <MeasurementValue
          measurement={measurement}
          {...(format ? { format } : {})}
          {...(unit ? { unit } : {})}
        />
        {outcome ? (
          <small className={`comparison-outcome comparison-outcome--${outcome}`}>
            {outcome === "within" ? "Within" : "Over"}
          </small>
        ) : null}
      </td>
    </tr>
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
