import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomSnapshot } from "../../shared/contracts";
import { clearSession, fetchRoom, leaveRoom, loadSession, type StoredSession } from "../api";
import { Brand } from "../components/Brand";
import { Inspector, type InspectorEvent } from "../components/Inspector";
import {
  type DisplayParticipant,
  type LocalRouting,
  ParticipantCard,
} from "../components/ParticipantCard";
import { SessionTelemetry } from "../telemetry/SessionTelemetry";

const SIMULATED: DisplayParticipant[] = [
  {
    id: "sim-grace",
    displayName: "Grace",
    role: "human",
    state: "connected",
    activity: "Listening",
    simulated: true,
  },
  {
    id: "sim-linus",
    displayName: "Linus",
    role: "human",
    state: "reconnecting",
    activity: "Listening",
    simulated: true,
  },
  {
    id: "sim-atlas",
    displayName: "Atlas",
    role: "ai",
    state: "connected",
    activity: "Partial context",
    simulated: true,
  },
  {
    id: "sim-sage",
    displayName: "Sage",
    role: "ai",
    state: "connected",
    activity: "Thinking",
    simulated: true,
  },
];

export function RoomPage({ code, navigate }: { code: string; navigate: (path: string) => void }) {
  const [session] = useState<StoredSession | null>(() => loadSession(code));
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [routing, setRouting] = useState<Record<string, LocalRouting>>({
    "sim-atlas": { hearsMe: true, iHearIt: true },
    "sim-sage": { hearsMe: false, iHearIt: true },
  });
  const [events, setEvents] = useState<InspectorEvent[]>([
    {
      id: crypto.randomUUID(),
      at: nowTime(),
      type: "SIM",
      text: "Presenter simulation initialised",
    },
    { id: crypto.randomUUID(), at: nowTime(), type: "CONN", text: "Draft 20 relay unavailable" },
  ]);
  const telemetry = useRef(new SessionTelemetry());
  const presenterMode = sessionStorage.getItem(`real-fabric:presenter:${code}`) === "true";

  useEffect(() => {
    let active = true;
    void fetchRoom(code)
      .then((snapshot) => {
        if (active) setRoom(snapshot);
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : "The room could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [code]);

  const participants = useMemo<DisplayParticipant[]>(() => {
    const real = (room?.participants ?? []).map<DisplayParticipant>((participant) => ({
      ...participant,
      activity: "Unavailable",
      simulated: false,
    }));
    if (presenterMode) return [...real, ...SIMULATED];
    return real;
  }, [presenterMode, room]);

  const copyInvite = async () => {
    await navigator.clipboard.writeText(`${location.origin}/room/${code}`);
    addEvent("JOIN", "Invite link copied");
  };

  const leave = async () => {
    if (session) {
      try {
        await leaveRoom(session);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Leave could not be confirmed.");
        return;
      }
      clearSession(code);
    }
    navigate("/");
  };

  const changeRouting = (participant: DisplayParticipant, value: LocalRouting) => {
    setRouting((current) => ({ ...current, [participant.id]: value }));
    addEvent(
      "ROUTE",
      `${participant.displayName}: hears me ${value.hearsMe ? "on" : "off"}; I hear it ${value.iHearIt ? "on" : "off"}`,
    );
    telemetry.current.record({
      type: "routing_change",
      participantId: participant.id,
      value: `${value.hearsMe}:${value.iHearIt}`,
    });
  };

  const ask = (participant: DisplayParticipant) => {
    addEvent("SIM", `${participant.displayName} hold-to-ask state changed`);
  };

  const addEvent = (type: InspectorEvent["type"], text: string) => {
    setEvents((current) =>
      [{ id: crypto.randomUUID(), at: nowTime(), type, text }, ...current].slice(0, 12),
    );
  };

  const exportTelemetry = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(telemetry.current.export(code));
    link.download = `real-fabric-${code}-sanitised.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  if (!session) {
    return (
      <main className="room-join-gate">
        <Brand />
        <h1>Join room {code}</h1>
        <p>
          This share link contains only the room code. Enter through the join screen to mint
          ephemeral participant credentials.
        </p>
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

  return (
    <main className="room-page">
      <header className="room-topbar">
        <Brand />
        <span>
          Room <b>{code}</b>
        </span>
        <span className="headphones headphones--small">⌁ Headphones required</span>
        <button className="button button--compact" type="button" onClick={() => void copyInvite()}>
          Copy invite
        </button>
        <button
          className="button button--compact button--danger"
          type="button"
          onClick={() => void leave()}
        >
          Leave room
        </button>
      </header>
      <div className="mobile-warning" role="status">
        <b>!</b> Desktop Chrome required for live audio
      </div>
      <div className="transport-warning" role="status">
        <b>Draft 20 relay unavailable.</b> Live audio is blocked;{" "}
        {presenterMode
          ? "the clearly labelled presenter simulation remains active."
          : "room membership and inspection remain available."}
      </div>
      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}
      <div className="room-layout">
        <section className="participant-surface" aria-label="Room participants">
          <p className="mobile-readonly">▣ Read-only room view</p>
          {participants.map((participant) => (
            <ParticipantCard
              key={participant.id}
              participant={participant}
              current={participant.id === session.participantId}
              {...(participant.role === "ai" && routing[participant.id]
                ? {
                    routing: routing[participant.id],
                    onRouting: (value: LocalRouting) => changeRouting(participant, value),
                    onAsk: () => ask(participant),
                  }
                : {})}
            />
          ))}
          {participants.length === 0 ? (
            <p className="empty-room">No active participants are exposed.</p>
          ) : null}
          <div className="mobile-actions">
            <button type="button" onClick={() => void copyInvite()}>
              Copy invite →
            </button>
            <button type="button" onClick={() => setInspectorOpen(true)}>
              Open inspector →
            </button>
          </div>
        </section>
        <Inspector
          participants={participants}
          events={events}
          open={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
        />
      </div>
      <footer className="presenter-health">
        <h2>Presenter health</h2>
        <Health label="Transport" value="Draft 20 unavailable" state="amber" />
        <Health label="Participants" value={`${participants.length} visible`} />
        <Health label="Subscriptions" value="Not exposed" />
        <Health label="Worst buffer" value="Not exposed" />
        <Health label="AI pipelines" value={presenterMode ? "2 simulated" : "None"} />
        <button type="button" onClick={exportTelemetry}>
          Export sanitised JSON
        </button>
      </footer>
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

function Health({
  label,
  value,
  state = "green",
}: {
  label: string;
  value: string;
  state?: "green" | "amber";
}) {
  return (
    <div className="health-item">
      <b>
        <i className={state} />
        {label}
      </b>
      <span>{value}</span>
    </div>
  );
}

function nowTime(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}
