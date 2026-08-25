import type { CheckState } from "../hooks/useCapabilities";

const LABELS: Record<CheckState, string> = {
  checking: "Checking",
  ready: "Ready",
  unavailable: "Unavailable",
  denied: "Permission denied",
  no_device: "No input device",
  not_tested: "Not tested",
};

export function StatusLight({ state }: { state: CheckState }) {
  return (
    <span className={`status status--${state}`}>
      <span className="status__light" aria-hidden="true" />
      {LABELS[state]}
    </span>
  );
}
