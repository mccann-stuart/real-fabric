/**
 * §9.3 latency budget, same-region reference path, p50 per stream.
 *
 * Held here so the inspector quotes the specification rather than a number
 * somebody typed into a component, and so the measured column can sit beside
 * the budget with "Not exposed" wherever the browser gives nothing (H15).
 */

export interface LatencyStage {
  id: string;
  label: string;
  budgetMs: number;
  /** Whether a browser client can observe this stage at all. */
  observable: "client" | "client_partial" | "not_exposed";
  note: string;
}

export const LATENCY_STAGES: LatencyStage[] = [
  {
    id: "capture",
    label: "Capture quantum and frame fill",
    budgetMs: 20,
    observable: "client",
    note: "Mean media span across completed capture frames in this browser session.",
  },
  {
    id: "encode",
    label: "Opus encode, including algorithmic delay",
    budgetMs: 15,
    observable: "client_partial",
    note: "Encode-to-output callback turnaround; WebCodecs does not expose algorithmic delay.",
  },
  {
    id: "network",
    label: "Send, relay, receive",
    budgetMs: 40,
    observable: "client_partial",
    note: "Smoothed relay RTT where WebTransport.getStats() is exposed by the browser.",
  },
  {
    id: "jitter",
    label: "Jitter buffer, nominal",
    budgetMs: 60,
    observable: "client",
    note: "Mean receiver hold, falling back to the active target before the first decoded object.",
  },
  {
    id: "decode",
    label: "Decode and mix",
    budgetMs: 15,
    observable: "client_partial",
    note: "Decoder callback turnaround plus AudioContext output latency where both are exposed.",
  },
];

export const TOTAL_BUDGET_MS = LATENCY_STAGES.reduce((sum, stage) => sum + stage.budgetMs, 0);

/** §9.3 targets, at the §9.1 reference composition. */
export const LATENCY_TARGETS = {
  p50Ms: 250,
  p95Ms: 500,
  composition: "six humans and two AIs, one region, wired or good wifi",
};
