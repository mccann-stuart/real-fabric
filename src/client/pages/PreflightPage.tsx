import { Brand } from "../components/Brand";
import { PreflightPanel } from "../components/PreflightPanel";
import { SignalPath } from "../components/SignalPath";
import { useCapabilities } from "../hooks/useCapabilities";

export function PreflightPage({ navigate }: { navigate: (path: string) => void }) {
  const { report, testMicrophone } = useCapabilities();
  return (
    <main className="preflight-page">
      <header className="topbar">
        <Brand />
        <button className="link-button" type="button" onClick={() => navigate("/")}>
          ← Back to room entry
        </button>
      </header>
      <section className="preflight-intro">
        <div>
          <h1>Conference network pre-flight</h1>
          <p>Checks this browser and network without joining a room or publishing audio.</p>
          <p className="headphones">⌁ Headphones required</p>
          <button
            className="button button--primary"
            type="button"
            onClick={() => void testMicrophone()}
          >
            Test microphone permission
          </button>
        </div>
        <SignalPath />
      </section>
      <PreflightPanel report={report} expanded />
      <section className="advice-rail">
        <h2>Recovery advice</h2>
        <p>
          <b>Relay or UDP blocked:</b> retry once, then use the documented phone hotspot. The build
          has no WebRTC or WebSocket audio fallback.
        </p>
        <p>
          <b>Draft unavailable:</b> the UI and presenter simulation remain usable; live audio stays
          blocked until a draft-20 browser-to-relay trace passes.
        </p>
      </section>
    </main>
  );
}
