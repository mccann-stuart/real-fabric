import { allFailureStates } from "../../shared/failures";
import { Brand } from "../components/Brand";
import { PinnedConfigSummary } from "../components/PinnedConfigBanner";
import { PreflightPanel } from "../components/PreflightPanel";
import { SignalPath } from "../components/SignalPath";
import { useCapabilities } from "../hooks/useCapabilities";

/**
 * §4.1: a separate shareable URL runs the same checks plus a relay reachability
 * probe, without joining. Run it on the venue network before the talk.
 *
 * It also carries the full §10 failure catalogue, so H14's "distinct state with
 * its own recovery advice" is inspectable before anything goes wrong rather
 * than only discoverable by breaking the demo.
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

      <PreflightPanel report={report} expanded />

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
          audio stays blocked until a draft-20 browser-to-relay trace passes.
        </p>
      </section>

      {/* H14: one row per §10 failure, each with its own copy and advice. */}
      <section className="failure-catalogue">
        <div className="section-heading">
          <h2>Failure states (§10)</h2>
          <span>{allFailureStates().length} distinct states · no silent fallback</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Failure</th>
              <th>What you see</th>
              <th>What the build does</th>
              <th>What to do</th>
            </tr>
          </thead>
          <tbody>
            {allFailureStates().map((failure) => (
              <tr key={failure.code} data-failure={failure.code}>
                <th scope="row">
                  {failure.title}
                  <small>{failure.severity}</small>
                </th>
                <td>{failure.experience}</td>
                <td>{failure.behaviour}</td>
                <td>{failure.recovery}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
