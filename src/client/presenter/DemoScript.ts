import { BARGE_IN_BUDGET_MS, ROUTING_CHANGE_BUDGET_MS } from "../../shared/contracts";
import type { Measurement } from "../../shared/measurement";

/**
 * H16: the §12 script is the only pass/fail product measure for v1, and the
 * release gate is two clean runs end to end.
 *
 * This encodes the script and tracks the runs. Checks the client can actually
 * observe are evaluated automatically; the rest are presenter judgement and are
 * marked as such rather than being auto-passed, because a runner that claims to
 * verify "the grid reflows without churn" would be inventing a result.
 */

export type StepOutcome = "pending" | "passed" | "failed" | "skipped";
export type Verification = "automatic" | "presenter";

export interface DemoStep {
  id: string;
  /** Cue time from §12, in seconds. */
  atSeconds: number;
  action: string;
  mustBeVisible: string;
  verification: Verification;
}

/** Everything an automatic check is allowed to look at. */
export interface DemoContext {
  msSinceRoomOpen: number;
  participantCount: number;
  /** AIs whose pipeline is speaking. §12 at 0:35 requires zero. */
  aisSpeaking: number;
  publishedTracks: Measurement<number>;
  subscribedTracks: Measurement<number>;
  lastBargeInMs: Measurement<number>;
  lastRoutingChangeMs: Measurement<number>;
  partialContextAiIds: readonly string[];
  floorQueueLength: number;
  /** H12: set if any object was played twice after the reload. */
  duplicatePlaybackDetected: boolean;
  identityReclaimed: boolean;
  /** H15: true when every unobservable figure on screen reads Not exposed. */
  unobservablesLabelled: boolean;
}

export interface StepResult {
  stepId: string;
  outcome: StepOutcome;
  detail: string;
  at: number;
}

export interface DemoRun {
  index: number;
  startedAt: number;
  finishedAt: number | null;
  results: StepResult[];
  clean: boolean;
}

export const DEMO_STEPS: DemoStep[] = [
  {
    id: "open",
    atSeconds: 0,
    action: "Presenter opens the room on the pinned browser",
    mustBeVisible: "Ready within 5 s",
    verification: "automatic",
  },
  {
    id: "arrivals",
    atSeconds: 15,
    action: "Share the link; several people join, or presenter mode adds simulated participants",
    mustBeVisible: "Each arrival appears within 10 s; grid reflows without churn",
    verification: "presenter",
  },
  {
    id: "human_exchange",
    atSeconds: 35,
    action: "Humans exchange a few sentences",
    mustBeVisible: "One track per voice in the inspector; every AI silent",
    verification: "automatic",
  },
  {
    id: "fan_out",
    atSeconds: 60,
    action: "Presenter opens the subscription graph",
    mustBeVisible: "Edges per participant; one track out, n-1 in",
    verification: "automatic",
  },
  {
    id: "address_ai",
    atSeconds: 80,
    action: "Presenter addresses one AI by name",
    mustBeVisible: "Only that AI shows Thinking; first audio within 1.5 s; its track appears",
    verification: "presenter",
  },
  {
    id: "barge_in",
    atSeconds: 105,
    action: "Presenter interrupts mid-answer",
    mustBeVisible: "Silent within 300 ms; state shows Interrupted",
    verification: "automatic",
  },
  {
    id: "routing_off",
    atSeconds: 120,
    action: "Presenter turns off Hears me for that AI, keeps talking, then asks what was said",
    mustBeVisible: "Subscription edge disappears; card reads Partial context; it cannot answer",
    verification: "automatic",
  },
  {
    id: "floor_control",
    atSeconds: 145,
    action: "Presenter addresses a second AI while the first is speaking",
    mustBeVisible: "Floor control holds; second shows Thinking, then speaks; no overlap",
    verification: "automatic",
  },
  {
    id: "membership_churn",
    atSeconds: 165,
    action: "A participant leaves; another joins",
    mustBeVisible: "Graph updates live; nobody's audio interrupted",
    verification: "presenter",
  },
  {
    id: "reload",
    atSeconds: 180,
    action: "Presenter reloads the page",
    mustBeVisible: "Identity and routing reclaimed; no duplicate playback",
    verification: "automatic",
  },
  {
    id: "measurements",
    atSeconds: 195,
    action: "Presenter shows latency by stage and capacity state",
    mustBeVisible: "Real figures, Not exposed where the browser gives nothing",
    verification: "automatic",
  },
  {
    id: "leave",
    atSeconds: 210,
    action: "Presenter leaves",
    mustBeVisible: "Capture stops, sessions close, AI workers terminate, credentials expire",
    verification: "presenter",
  },
];

/** H16 release gate: the script must run end to end, twice, clean. */
export const REQUIRED_CLEAN_RUNS = 2;

export function evaluateStep(
  stepId: string,
  context: DemoContext,
): { outcome: Exclude<StepOutcome, "pending">; detail: string } {
  switch (stepId) {
    case "open":
      return context.msSinceRoomOpen <= 5_000
        ? { outcome: "passed", detail: `Ready in ${context.msSinceRoomOpen} ms` }
        : { outcome: "failed", detail: `Took ${context.msSinceRoomOpen} ms, over the 5 s cue` };

    case "human_exchange":
      return context.aisSpeaking === 0
        ? { outcome: "passed", detail: "No AI published during the human exchange" }
        : {
            outcome: "failed",
            detail: `${context.aisSpeaking} AI published unaddressed, which breaks H5`,
          };

    case "fan_out": {
      const { publishedTracks, subscribedTracks } = context;
      if (!publishedTracks.exposed || !subscribedTracks.exposed) {
        return {
          outcome: "skipped",
          detail: "Uplink and downlink counts are not observable without live transport",
        };
      }
      const expected = Math.max(0, context.participantCount - 1);
      return publishedTracks.value === 1 && subscribedTracks.value === expected
        ? {
            outcome: "passed",
            detail: `1 track out, ${subscribedTracks.value} in at ${context.participantCount} participants`,
          }
        : {
            outcome: "failed",
            detail: `Expected 1 out and ${expected} in; saw ${publishedTracks.value} out and ${subscribedTracks.value} in`,
          };
    }

    case "barge_in": {
      if (!context.lastBargeInMs.exposed) {
        return { outcome: "skipped", detail: "No barge-in was measured in this run" };
      }
      const latency = context.lastBargeInMs.value;
      return latency <= BARGE_IN_BUDGET_MS
        ? { outcome: "passed", detail: `Silent in ${latency} ms` }
        : {
            outcome: "failed",
            detail: `Took ${latency} ms, over the ${BARGE_IN_BUDGET_MS} ms budget`,
          };
    }

    case "routing_off": {
      if (!context.lastRoutingChangeMs.exposed) {
        return { outcome: "skipped", detail: "No routing change was measured in this run" };
      }
      const elapsed = context.lastRoutingChangeMs.value;
      if (elapsed > ROUTING_CHANGE_BUDGET_MS) {
        return {
          outcome: "failed",
          detail: `Routing change took ${elapsed} ms, over the ${ROUTING_CHANGE_BUDGET_MS} ms budget`,
        };
      }
      return context.partialContextAiIds.length > 0
        ? {
            outcome: "passed",
            detail: `Applied in ${elapsed} ms and the card reads Partial context`,
          }
        : {
            outcome: "failed",
            detail: "Routing changed but no AI card reads Partial context",
          };
    }

    case "floor_control":
      return context.aisSpeaking <= 1
        ? {
            outcome: "passed",
            detail: `${context.aisSpeaking} AI speaking with ${context.floorQueueLength} waiting`,
          }
        : {
            outcome: "failed",
            detail: `${context.aisSpeaking} AIs published at once; floor control did not hold`,
          };

    case "reload":
      if (!context.identityReclaimed) {
        return { outcome: "failed", detail: "Identity was not reclaimed inside the 60 s window" };
      }
      return context.duplicatePlaybackDetected
        ? { outcome: "failed", detail: "An object played twice after the reload" }
        : {
            outcome: "passed",
            detail: "Identity and routing reclaimed with no duplicate playback",
          };

    case "measurements":
      return context.unobservablesLabelled
        ? { outcome: "passed", detail: "Every unobservable figure reads Not exposed" }
        : { outcome: "failed", detail: "A figure the client cannot observe rendered as a value" };

    default:
      return {
        outcome: "skipped",
        detail: "This cue is presenter judgement and is not auto-verified",
      };
  }
}

export class DemoRunner {
  private runs: DemoRun[] = [];
  private active: DemoRun | null = null;
  private cursor = 0;

  constructor(private readonly now: () => number = Date.now) {}

  begin(): DemoRun {
    const run: DemoRun = {
      index: this.runs.length + 1,
      startedAt: this.now(),
      finishedAt: null,
      results: DEMO_STEPS.map((step) => ({
        stepId: step.id,
        outcome: "pending" as StepOutcome,
        detail: "",
        at: 0,
      })),
      clean: false,
    };
    this.active = run;
    this.runs = [...this.runs, run];
    this.cursor = 0;
    return run;
  }

  get currentStep(): DemoStep | null {
    if (!this.active) return null;
    return DEMO_STEPS[this.cursor] ?? null;
  }

  /**
   * Records the current step. Automatic steps are evaluated from `context`;
   * presenter steps take the outcome the presenter gives.
   */
  record(
    context: DemoContext,
    presenterOutcome?: Exclude<StepOutcome, "pending">,
  ): StepResult | null {
    const run = this.active;
    const step = this.currentStep;
    if (!run || !step) return null;

    const evaluated =
      step.verification === "automatic"
        ? evaluateStep(step.id, context)
        : {
            outcome: presenterOutcome ?? ("skipped" as const),
            detail:
              presenterOutcome === undefined
                ? "Presenter did not confirm this cue"
                : "Confirmed by the presenter",
          };

    const result: StepResult = {
      stepId: step.id,
      outcome: evaluated.outcome,
      detail: evaluated.detail,
      at: this.now(),
    };
    run.results = run.results.map((entry) => (entry.stepId === step.id ? result : entry));
    this.cursor += 1;
    if (this.cursor >= DEMO_STEPS.length) this.finish();
    return result;
  }

  private finish(): void {
    const run = this.active;
    if (!run) return;
    run.finishedAt = this.now();
    // Clean means nothing failed. A skipped cue is not a pass, so a run with
    // skipped automatic checks does not count towards the release gate.
    run.clean = run.results.every((result) => result.outcome === "passed");
    this.active = null;
  }

  abandon(reason: string): void {
    const run = this.active;
    if (!run) return;
    run.results = run.results.map((result) =>
      result.outcome === "pending"
        ? { ...result, outcome: "failed" as StepOutcome, detail: reason, at: this.now() }
        : result,
    );
    run.finishedAt = this.now();
    run.clean = false;
    this.active = null;
  }

  get history(): DemoRun[] {
    return this.runs.map((run) => ({ ...run, results: [...run.results] }));
  }

  get cleanRuns(): number {
    return this.runs.filter((run) => run.clean).length;
  }

  /** H16: the release gate itself. */
  get releaseGateMet(): boolean {
    return this.cleanRuns >= REQUIRED_CLEAN_RUNS;
  }

  get running(): boolean {
    return this.active !== null;
  }
}
