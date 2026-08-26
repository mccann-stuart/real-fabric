import { useState } from "react";
import { MAX_SIMULATED_PARTICIPANTS, PINNED_MOQT_DRAFT } from "../../shared/contracts";
import { configurePresenter, createRoom, joinRoom, normaliseCode, storeSession } from "../api";
import { Brand } from "../components/Brand";
import { PinnedConfigBanner } from "../components/PinnedConfigBanner";
import { PreflightPanel } from "../components/PreflightPanel";
import { SignalPath } from "../components/SignalPath";
import { generateRandomDisplayName } from "../displayName";
import { useCapabilities } from "../hooks/useCapabilities";
import { rememberRelayCredential } from "../session/RoomSession";

const MIC_BARS = Array.from({ length: 18 }, (_, value) => ({ id: `mic-${value}`, value }));

export function EntryPage({
  navigate,
  initialCode = "",
}: {
  navigate: (path: string) => void;
  initialCode?: string;
}) {
  const [displayName, setDisplayName] = useState("");
  const [roomCode, setRoomCode] = useState(normaliseCode(initialCode));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // H11: presenter simulation is a configurable number, not a fixed cast.
  const [simulatedHumans, setSimulatedHumans] = useState(5);
  const [simulatedAis, setSimulatedAis] = useState(2);
  const { report, level, testMicrophone, stopMicrophone } = useCapabilities();

  const enterRoom = async (mode: "create" | "join" | "presenter") => {
    let enteredName = displayName.trim();
    if (!enteredName && mode === "presenter") {
      setError("Enter your name before creating or joining a room.");
      return;
    }
    if (!enteredName) {
      enteredName = generateRandomDisplayName();
      setDisplayName(enteredName);
    }
    if (mode === "join" && roomCode.length !== 20) {
      setError("Enter the complete 20-character room code.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "join" ? await joinRoom(roomCode, enteredName) : await createRoom(enteredName);
      const session = storeSession({
        code: result.room.code,
        participantId: result.participant.id,
        rejoinToken: result.rejoinToken,
        displayName: enteredName,
      });
      // §8: the relay credential stays in memory. It is never stored and never
      // placed in a URL that could be shared.
      rememberRelayCredential(result.participant.id, result.relayCredential);

      if (mode === "presenter") {
        sessionStorage.setItem(`real-fabric:presenter:${result.room.code}`, "true");
        await configurePresenter(session, {
          simulatedHumans,
          simulatedAis,
          // FR4: no live pipeline exists, so scripted responses are the only
          // honest option, and they are labelled as scripted everywhere.
          scriptedResponses: true,
        });
      }
      stopMicrophone();
      navigate(`/room/${result.room.code}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The room could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="entry-page">
      <header className="topbar">
        <Brand />
        <button className="link-button" type="button" onClick={() => navigate("/preflight")}>
          Protocol inspector →
        </button>
      </header>
      <PinnedConfigBanner />
      <div className="entry-layout">
        <section className="entry-form" aria-labelledby="entry-title">
          <h1 id="entry-title">People and AIs speaking over Media over QUIC.</h1>
          {/* H4: stated before joining. */}
          <p className="headphones">⌁ Headphones required</p>
          <div className="form-grid">
            <label>
              Your name
              <input
                autoComplete="name"
                maxLength={80}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Ada Lovelace"
              />
            </label>
            <label>
              Room code
              <input
                autoCapitalize="characters"
                maxLength={20}
                value={roomCode}
                onChange={(event) => setRoomCode(normaliseCode(event.target.value))}
                placeholder="20-character code"
              />
            </label>
            <button
              className="button button--primary"
              disabled={busy}
              type="button"
              onClick={() => void enterRoom("create")}
            >
              Create demo room
            </button>
            <button
              className="button"
              disabled={busy}
              type="button"
              onClick={() => void enterRoom("join")}
            >
              Join room
            </button>
            <button
              className="button"
              disabled={busy}
              type="button"
              onClick={() => void enterRoom("presenter")}
            >
              Solo presenter mode
            </button>
            <button
              className="link-button link-button--large"
              type="button"
              onClick={() => navigate("/preflight")}
            >
              Run pre-flight only →
            </button>
          </div>

          <fieldset className="simulation-config">
            <legend>Solo presenter mode — simulated participants</legend>
            <label>
              Humans
              <input
                type="number"
                min={0}
                max={MAX_SIMULATED_PARTICIPANTS}
                value={simulatedHumans}
                onChange={(event) => setSimulatedHumans(clamp(Number(event.target.value)))}
              />
            </label>
            <label>
              AIs
              <input
                type="number"
                min={0}
                max={MAX_SIMULATED_PARTICIPANTS}
                value={simulatedAis}
                onChange={(event) => setSimulatedAis(clamp(Number(event.target.value)))}
              />
            </label>
            <p>
              Simulated participants are labelled everywhere they appear and never stand in for a
              working relay or AI pipeline.
            </p>
          </fieldset>

          <button className="mic-test" type="button" onClick={() => void testMicrophone()}>
            <span>◉ Mic level test</span>
            <output className="sr-only">Microphone level {Math.round(level * 100)} percent</output>
            <span className="mic-test__wave" aria-hidden="true">
              {MIC_BARS.map((bar) => (
                <i
                  key={bar.id}
                  style={{
                    height: `${Math.max(4, level * 38 * (((bar.value * 7) % 10) / 10 + 0.25))}px`,
                  }}
                />
              ))}
            </span>
          </button>
          {error ? (
            <p className="error-banner" role="alert">
              {error}
            </p>
          ) : null}
        </section>
        <SignalPath />
      </div>
      <PreflightPanel report={report} />
      <footer className="maturity-row">
        <span>
          <b>QUIC</b> — standard
        </span>
        <span>
          <b>WebTransport</b> — working draft
        </span>
        <span>
          <b>MOQT</b> — draft {PINNED_MOQT_DRAFT} live target
        </span>
        <span>No media is stored.</span>
      </footer>
    </main>
  );
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_SIMULATED_PARTICIPANTS, Math.max(0, Math.trunc(value)));
}
