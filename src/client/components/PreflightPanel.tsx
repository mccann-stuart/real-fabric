import type { CapabilityReport, CheckState } from "../hooks/useCapabilities";
import { FailureBanner } from "./FailureBanner";
import { StatusLight } from "./StatusLight";

const CHECKS: Array<
  [
    keyof Pick<
      CapabilityReport,
      "secureContext" | "webTransport" | "opus" | "microphone" | "relay"
    >,
    string,
  ]
> = [
  ["secureContext", "Secure context"],
  ["webTransport", "WebTransport"],
  ["opus", "WebCodecs Opus"],
  ["microphone", "Microphone"],
  ["relay", "Relay reachability"],
];

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
        <span>MOQT draft 20 · no fallback</span>
      </div>
      <div className="preflight-grid">
        {CHECKS.map(([key, label]) => (
          <div className="preflight-check" key={key}>
            <strong>{label}</strong>
            <StatusLight state={report[key] as CheckState} />
          </div>
        ))}
      </div>
      <p className="preflight-reason">{report.relayReason}</p>
      {/* H14: name the specific missing capability, with its own recovery advice. */}
      {report.failure ? <FailureBanner code={report.failure} /> : null}
    </section>
  );
}
