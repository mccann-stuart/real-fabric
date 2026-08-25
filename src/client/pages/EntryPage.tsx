import { useState } from "react";
import { createRoom, joinRoom, normaliseCode, storeSession } from "../api";
import { Brand } from "../components/Brand";
import { PreflightPanel } from "../components/PreflightPanel";
import { SignalPath } from "../components/SignalPath";
import { useCapabilities } from "../hooks/useCapabilities";

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
  const { report, level, testMicrophone, stopMicrophone } = useCapabilities();

  const enterRoom = async (mode: "create" | "join" | "presenter") => {
    if (!displayName.trim()) {
      setError("Enter your name before creating or joining a room.");
      return;
    }
    if (mode === "join" && roomCode.length !== 20) {
      setError("Enter the complete 20-character room code.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "join"
          ? await joinRoom(roomCode, displayName.trim())
          : await createRoom(displayName.trim());
      storeSession({
        code: result.room.code,
        participantId: result.participant.id,
        rejoinToken: result.rejoinToken,
        displayName: displayName.trim(),
      });
      if (mode === "presenter")
        sessionStorage.setItem(`real-fabric:presenter:${result.room.code}`, "true");
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
      <div className="entry-layout">
        <section className="entry-form" aria-labelledby="entry-title">
          <h1 id="entry-title">People and AIs speaking over Media over QUIC.</h1>
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
          <b>MOQT</b> — draft 20 target
        </span>
        <span>No media is stored.</span>
      </footer>
    </main>
  );
}
