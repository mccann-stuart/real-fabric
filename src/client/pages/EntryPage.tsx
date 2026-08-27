import { MAX_SIMULATED_PARTICIPANTS, PINNED_MOQT_DRAFT } from "../../shared/contracts";
import { Brand } from "../components/Brand";
import { FailureBanner } from "../components/FailureBanner";
import { PinnedConfigBanner } from "../components/PinnedConfigBanner";
import { PreflightPanel } from "../components/PreflightPanel";
import { SignalPath } from "../components/SignalPath";
import { useCapabilities } from "../hooks/useCapabilities";
import { useEntryForm } from "../hooks/useEntryForm";

const MIC_BARS = Array.from({ length: 18 }, (_, value) => ({ id: `mic-${value}`, value }));

export function EntryPage({
  navigate,
  initialCode = "",
}: {
  navigate: (path: string) => void;
  initialCode?: string;
}) {
  const { report, level, testMicrophone, stopMicrophone } = useCapabilities();
  const {
    displayName,
    setDisplayName,
    roomCode,
    setRoomCode,
    busy,
    error,
    simulatedHumans,
    setSimulatedHumans,
    simulatedAis,
    setSimulatedAis,
    enterRoom,
  } = useEntryForm({ navigate, initialCode, stopMicrophone });

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
                onChange={(event) => setRoomCode(event.target.value)}
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
                onChange={(event) => setSimulatedHumans(Number(event.target.value))}
              />
            </label>
            <label>
              AIs
              <input
                type="number"
                min={0}
                max={MAX_SIMULATED_PARTICIPANTS}
                value={simulatedAis}
                onChange={(event) => setSimulatedAis(Number(event.target.value))}
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
        </section>
        <SignalPath />
      </div>
      <PreflightPanel report={report} showFailure={false} />
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
      <section className="page-alerts" aria-labelledby="entry-alerts-title">
        <h2 className="sr-only" id="entry-alerts-title">
          Alerts and notices
        </h2>
        {error ? (
          <p className="error-banner" role="alert">
            {error}
          </p>
        ) : null}
        {report.failure ? <FailureBanner code={report.failure} /> : null}
        <PinnedConfigBanner />
      </section>
    </main>
  );
}
