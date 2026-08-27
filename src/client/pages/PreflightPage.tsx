import { Brand } from "../components/Brand";
import { FailureBanner } from "../components/FailureBanner";
import { PinnedConfigSummary } from "../components/PinnedConfigBanner";
import { PreflightPanel } from "../components/PreflightPanel";
import { SignalPath } from "../components/SignalPath";
import { useCapabilities } from "../hooks/useCapabilities";

/**
 * §4.1: a separate shareable URL runs the same checks plus a relay reachability
 * probe, without joining. Run it on the venue network before the talk.
 */
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

      <PreflightPanel report={report} expanded showFailure={false} />

      {/* H3 */}
      <section className="advice-rail">
        <h2>Tested configuration</h2>
        <PinnedConfigSummary />
      </section>

      <section className="advice-rail">
        <h2>Recovery advice</h2>
        <p>
          <b>Relay or UDP blocked:</b> retry once, then use the documented phone hotspot. The build
          has no WebRTC or WebSocket audio fallback.
        </p>
        <p>
          <b>Draft unavailable:</b> the UI, routing and presenter simulation remain usable; live
          audio stays blocked until a browser-to-relay trace passes on the pinned draft.
        </p>
      </section>

      {report.failure ? (
        <section className="page-alerts" aria-labelledby="preflight-alerts-title">
          <h2 className="sr-only" id="preflight-alerts-title">
            Alerts and notices
          </h2>
          <FailureBanner code={report.failure} />
        </section>
      ) : null}
    </main>
  );
}
