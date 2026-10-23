import type { CheckState } from "../hooks/useCapabilities";

const LABELS: Record<CheckState, string> = {
  checking: "Checking",
  ready: "Ready",
  unavailable: "Unavailable",
  denied: "Permission denied",
  no_device: "No input device",
  not_tested: "Not tested",
};

export function StatusLight({ state, label }: { state: CheckState; label?: string | undefined }) {
  const statusText = LABELS[state];
  const ariaLabel = label ? `${label}: ${statusText}` : `Status: ${statusText}`;
  return (
    <span className={`status status--${state}`} role="status" aria-label={ariaLabel}>
      <span className="status__light" aria-hidden="true" />
      {statusText}
    </span>
  );
}
