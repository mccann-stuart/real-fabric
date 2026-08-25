import { useState } from "react";
import type { DisplayParticipant } from "./ParticipantCard";

export interface InspectorEvent {
  id: string;
  at: string;
  type: "SIM" | "JOIN" | "ROUTE" | "CONN";
  text: string;
}

export function Inspector({
  participants,
  events,
  open,
  onClose,
}: {
  participants: DisplayParticipant[];
  events: InspectorEvent[];
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"signal" | "graph" | "objects">("signal");
  const simulated = participants.filter(
    (participant) => participant.simulated && participant.state !== "left",
  );
  return (
    <aside className={`inspector${open ? " inspector--open" : ""}`} aria-label="Protocol inspector">
      <div className="inspector__mobile-heading">
        <h2>Inspector</h2>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </div>
      <div className="inspector__tabs" role="tablist">
        <button
          type="button"
          className={tab === "signal" ? "active" : ""}
          onClick={() => setTab("signal")}
        >
          Signal path
        </button>
        <button
          type="button"
          className={tab === "graph" ? "active" : ""}
          onClick={() => setTab("graph")}
        >
          Subscription graph
        </button>
        <button
          type="button"
          className={tab === "objects" ? "active" : ""}
          onClick={() => setTab("objects")}
        >
          Objects
        </button>
      </div>
      <div className="inspector__summary">
        <b>{simulated.length ? "1 simulated track out" : "Outbound: Not exposed"}</b>
        <b>
          {simulated.length ? `${simulated.length} simulated tracks in` : "Inbound: Not exposed"}
        </b>
      </div>
      <div className="inspector__body">
        {tab === "signal" ? <Signal participants={participants} /> : null}
        {tab === "graph" ? <Graph participants={participants} /> : null}
        {tab === "objects" ? <Objects /> : null}
      </div>
      <section className="event-stream">
        <div className="section-heading">
          <h3>Event stream</h3>
          <span>Simulation only</span>
        </div>
        <ol>
          {events.map((event) => (
            <li key={event.id}>
              <time>{event.at}</time>
              <b>[{event.type}]</b>
              <span>{event.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}

function Signal({ participants }: { participants: DisplayParticipant[] }) {
  const simulated = participants.filter((participant) => participant.simulated).length;
  return (
    <div className="inspector-signal">
      <p>
        <i className="coral" /> Browser publisher <small>Opus objects · simulation</small>
      </p>
      <span>↓</span>
      <p>
        <i /> WebTransport <small>Not connected</small>
      </p>
      <span>↓</span>
      <p>
        <i /> MoQ relay <small>Draft 20 unavailable</small>
      </p>
      <span>↓</span>
      <p>
        <i /> Subscribers {simulated ? `(${simulated} simulated)` : "(Not exposed)"}{" "}
        <small>{simulated ? "Simulated graph" : "Live transport unavailable"}</small>
      </p>
    </div>
  );
}

function Graph({ participants }: { participants: DisplayParticipant[] }) {
  return (
    <div className="graph-view">
      <div className="relay-node">
        Relay
        <br />
        <small>MOQT</small>
      </div>
      {participants.slice(0, 7).map((participant, index) => (
        <div className={`graph-node graph-node--${index}`} key={participant.id}>
          {participant.displayName.at(0)}
          <small>{participant.simulated ? "SIM" : participant.role.toUpperCase()}</small>
        </div>
      ))}
      <p>Illustrative edges · live transport unavailable</p>
    </div>
  );
}

function Objects() {
  return (
    <dl className="object-list">
      <div>
        <dt>Sequence</dt>
        <dd>Not exposed</dd>
      </div>
      <div>
        <dt>Object age</dt>
        <dd>Not exposed</dd>
      </div>
      <div>
        <dt>Size</dt>
        <dd>Not exposed</dd>
      </div>
      <div>
        <dt>Late drops</dt>
        <dd>Not exposed</dd>
      </div>
      <div>
        <dt>DTX</dt>
        <dd>Not exposed</dd>
      </div>
    </dl>
  );
}
