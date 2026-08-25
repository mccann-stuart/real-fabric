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
  observable: "client" | "not_exposed";
  note: string;
}

export const LATENCY_STAGES: LatencyStage[] = [
  {
    id: "capture",
    label: "Capture quantum and frame fill",
    budgetMs: 20,
    observable: "not_exposed",
    note: "The capture graph does not report its own quantum delay.",
  },
  {
    id: "encode",
    label: "Opus encode, including algorithmic delay",
    budgetMs: 15,
    observable: "not_exposed",
    note: "WebCodecs does not expose encoder algorithmic delay.",
  },
  {
    id: "network",
    label: "Send, relay, receive",
    budgetMs: 40,
    observable: "client",
    note: "Derived from the WebTransport round-trip time where the browser reports it.",
  },
  {
    id: "jitter",
    label: "Jitter buffer, nominal",
    budgetMs: 60,
    observable: "client",
    note: "The adaptive buffer's current target for the worst track.",
  },
  {
    id: "decode",
    label: "Decode and mix",
    budgetMs: 15,
    observable: "client",
    note: "AudioContext output latency, where the browser reports it.",
  },
];

export const TOTAL_BUDGET_MS = LATENCY_STAGES.reduce((sum, stage) => sum + stage.budgetMs, 0);

/** §9.3 targets, at the §9.1 reference composition. */
export const LATENCY_TARGETS = {
  p50Ms: 250,
  p95Ms: 500,
  composition: "six humans and two AIs, one region, wired or good wifi",
};
