import { PINNED_MOQT_DRAFT } from "../../shared/contracts";
import type { CapabilityReport, CheckState } from "../hooks/useCapabilities";
import type { ProbeState } from "../transport/NetworkProbe";
import { FailureBanner } from "./FailureBanner";
import { StatusLight } from "./StatusLight";

const REQUIRED_CHECKS: Array<[keyof CapabilityReport, string]> = [
  ["secureContext", "Secure context"],
  ["webTransport", "WebTransport"],
  ["webTransportReliability", "UDP-capable reliability"],
  ["opusEncoder", "Opus encoder"],
  ["opusDecoder", "Opus decoder"],
  ["capture", "20 ms audio capture"],
  ["playout", "AudioWorklet playout"],
  ["microphone", "Microphone"],
  ["relay", "Relay configuration"],
];

const OPTIONAL_CHECKS: Array<[keyof CapabilityReport, string]> = [
  ["audioSession", "Audio Session hint"],
  ["wakeLock", "Screen Wake Lock"],
  ["dtx", "Opus DTX"],
  ["lowLatencyCongestionControl", "Low-latency congestion"],
];

/** The probe has its own vocabulary; map it onto the shared status light. */
function probeLight(state: ProbeState): CheckState {
  switch (state) {
    case "reachable":
      return "ready";
    case "probing":
      return "checking";
    case "not_run":
      return "not_tested";
    default:
      return "unavailable";
  }
}

export function PreflightPanel({
  report,
  expanded = false,
}: {
  report: CapabilityReport;
  expanded?: boolean;
}) {
  return (
    <section
      className={`preflight-panel${expanded ? " preflight-panel--expanded" : ""}`}
      aria-labelledby="preflight-title"
    >
      <div className="section-heading">
        <h2 id="preflight-title">Pre-flight status</h2>
        <span>MOQT draft {PINNED_MOQT_DRAFT} · no fallback</span>
      </div>
      <div className="preflight-grid">
        {REQUIRED_CHECKS.map(([key, label]) => (
          <div className="preflight-check" key={key}>
            <strong>{label}</strong>
            <StatusLight state={report[key] as CheckState} />
          </div>
        ))}
        {/* §11.2: HTTP/3 and QUIC reachability, probed rather than assumed. */}
        <div className="preflight-check">
          <strong>HTTP/3 and QUIC</strong>
          <StatusLight state={probeLight(report.network.state)} />
        </div>
      </div>
      <fieldset className="preflight-grid preflight-grid--optional">
        <legend className="sr-only">Optional enhancements</legend>
        {OPTIONAL_CHECKS.map(([key, label]) => (
          <div className="preflight-check" key={key}>
            <strong>{label}</strong>
            <StatusLight state={report[key] as CheckState} />
          </div>
        ))}
      </fieldset>
      <p className="preflight-reason">{report.relayReason}</p>
      <p className="preflight-reason">{report.codecReason}</p>
      <p className="preflight-reason">{report.captureReason}</p>
      <p className="preflight-reason">{report.playoutReason}</p>
      <p className="preflight-reason">{report.network.detail}</p>
      {report.network.remediation ? (
        <p className="preflight-reason">{report.network.remediation}</p>
      ) : null}
      {/* H14: name the specific missing capability, with its own recovery advice. */}
      {report.failure ? <FailureBanner code={report.failure} /> : null}
    </section>
  );
}
