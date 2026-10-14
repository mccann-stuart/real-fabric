import {
  DEMO_STEPS,
  type DemoRun,
  type DemoStep,
  REQUIRED_CLEAN_RUNS,
  type StepResult,
} from "../presenter/DemoScript";

/**
 * H16: the §12 script is the release gate, so the presenter can see exactly
 * which cue they are on, what must be visible, and whether two runs have gone
 * clean end to end.
 */

export interface DemoScriptPanelProps {
  currentStep: DemoStep | null;
  runs: readonly DemoRun[];
  cleanRuns: number;
  releaseGateMet: boolean;
  running: boolean;
  onBegin: () => void;
  onRecord: (outcome: "passed" | "failed" | "skipped") => void;
  onAbandon: () => void;
}

export function DemoScriptPanel({
  currentStep,
  runs,
  cleanRuns,
  releaseGateMet,
  running,
  onBegin,
  onRecord,
  onAbandon,
}: DemoScriptPanelProps) {
  const latest = runs.at(-1);
  return (
    <section className="demo-script" aria-labelledby="demo-script-title">
      <DemoScriptHeader cleanRuns={cleanRuns} releaseGateMet={releaseGateMet} />

      {running && currentStep ? (
        <DemoCurrentStep currentStep={currentStep} onRecord={onRecord} onAbandon={onAbandon} />
      ) : (
        <button className="button button--primary" type="button" onClick={onBegin}>
          {runs.length === 0 ? "Start run 1" : `Start run ${runs.length + 1}`}
        </button>
      )}

      <DemoStepsList latest={latest} running={running} currentStepId={currentStep?.id} />
    </section>
  );
}

interface DemoScriptHeaderProps {
  cleanRuns: number;
  releaseGateMet: boolean;
}

function DemoScriptHeader({ cleanRuns, releaseGateMet }: DemoScriptHeaderProps) {
  return (
    <div className="section-heading">
      <h2 id="demo-script-title">Demo script (§12)</h2>
      <span className={releaseGateMet ? "gate gate--met" : "gate"} role="status" aria-live="polite">
        {cleanRuns} / {REQUIRED_CLEAN_RUNS} clean runs
        {releaseGateMet ? " — release gate met" : ""}
      </span>
    </div>
  );
}

interface DemoCurrentStepProps {
  currentStep: DemoStep;
  onRecord: (outcome: "passed" | "failed" | "skipped") => void;
  onAbandon: () => void;
}

function DemoCurrentStep({ currentStep, onRecord, onAbandon }: DemoCurrentStepProps) {
  const cueTime = formatCue(currentStep.atSeconds);
  return (
    <div className="demo-script__current">
      <b>
        {cueTime} · {currentStep.action}
      </b>
      <p>{currentStep.mustBeVisible}</p>
      <p className="demo-script__verification">
        {currentStep.verification === "automatic"
          ? "Checked automatically from session state."
          : "Presenter judgement — confirm what you saw."}
      </p>
      <div className="demo-script__actions">
        {currentStep.verification === "automatic" ? (
          <button
            type="button"
            aria-label={`Evaluate cue at ${cueTime}`}
            onClick={() => onRecord("passed")}
          >
            Evaluate cue
          </button>
        ) : (
          <>
            <button
              type="button"
              aria-label={`Mark cue at ${cueTime} as seen`}
              onClick={() => onRecord("passed")}
            >
              Seen
            </button>
            <button
              type="button"
              aria-label={`Mark cue at ${cueTime} as not seen`}
              onClick={() => onRecord("failed")}
            >
              Not seen
            </button>
            <button
              type="button"
              aria-label={`Skip cue at ${cueTime}`}
              onClick={() => onRecord("skipped")}
            >
              Skip
            </button>
          </>
        )}
        <button
          type="button"
          className="button--danger"
          aria-label="Abandon current demo run"
          onClick={onAbandon}
        >
          Abandon run
        </button>
      </div>
    </div>
  );
}

interface DemoStepsListProps {
  latest?: DemoRun | undefined;
  running: boolean;
  currentStepId?: string | undefined;
}

function DemoStepsList({ latest, running, currentStepId }: DemoStepsListProps) {
  return (
    <ol className="demo-script__steps">
      {DEMO_STEPS.map((step) => {
        const result = latest?.results.find((entry) => entry.stepId === step.id);
        const isCurrent = running && currentStepId === step.id;
        return (
          <li
            key={step.id}
            className={`demo-step demo-step--${result?.outcome ?? "pending"}${isCurrent ? " demo-step--current" : ""}`}
            aria-current={isCurrent ? "step" : undefined}
          >
            <time>{formatCue(step.atSeconds)}</time>
            <span>{step.action}</span>
            <em className="demo-step__outcome">{describe(result)}</em>
          </li>
        );
      })}
    </ol>
  );
}

function describe(result: StepResult | undefined): string {
  if (!result || result.outcome === "pending") return "pending";
  return `${result.outcome}${result.detail ? ` — ${result.detail}` : ""}`;
}

function formatCue(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
