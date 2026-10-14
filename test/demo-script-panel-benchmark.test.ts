import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemoScriptPanel } from "../src/client/components/DemoScriptPanel";
import { DEMO_STEPS, type DemoRun, type StepResult } from "../src/client/presenter/DemoScript";

describe("DemoScriptPanel Benchmark", () => {
  it("measures DemoScriptPanel render time over 20,000 iterations", { timeout: 30_000 }, () => {
    const mockResults: StepResult[] = DEMO_STEPS.map((step, idx) => ({
      stepId: step.id,
      outcome: idx % 2 === 0 ? "passed" : "failed",
      detail: `Step ${step.id} outcome detail text`,
      at: 1000 + idx,
    }));

    const runs: DemoRun[] = [
      {
        index: 1,
        startedAt: 1000,
        finishedAt: 2000,
        results: mockResults,
        clean: false,
      },
    ];

    const props = {
      currentStep: DEMO_STEPS[0] ?? null,
      runs,
      cleanRuns: 0,
      releaseGateMet: false,
      running: true,
      onBegin: () => {},
      onRecord: () => {},
      onAbandon: () => {},
    };

    const iterations = 20_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      renderToStaticMarkup(React.createElement(DemoScriptPanel, props));
    }
    const end = performance.now();
    const duration = end - start;

    console.log(
      `[BENCHMARK] DemoScriptPanel render (${iterations} ops): ${duration.toFixed(2)} ms`,
    );
    expect(duration).toBeGreaterThan(0);
  });

  it("benchmarks lookup scaling between linear search and Map index across step count sizes", {
    timeout: 30_000,
  }, () => {
    const iterations = 10_000;

    for (const count of [12, 100, 200]) {
      const steps = Array.from({ length: count }, (_, i) => ({
        id: `step-${i}`,
        atSeconds: i * 10,
        action: `Action ${i}`,
        mustBeVisible: `Visible ${i}`,
        verification: "automatic" as const,
      }));

      const results: StepResult[] = steps.map((s, idx) => ({
        stepId: s.id,
        outcome: "passed",
        detail: `Detail ${idx}`,
        at: idx,
      }));

      const startFind = performance.now();
      for (let i = 0; i < iterations; i++) {
        for (const step of steps) {
          const _res = results.find((r) => r.stepId === step.id);
        }
      }
      const timeFind = performance.now() - startFind;

      const startMap = performance.now();
      for (let i = 0; i < iterations; i++) {
        const resultMap = new Map<string, StepResult>();
        for (const r of results) {
          resultMap.set(r.stepId, r);
        }
        for (const step of steps) {
          const _res = resultMap.get(step.id);
        }
      }
      const timeMap = performance.now() - startMap;

      console.log(
        `[BENCHMARK N=${count}, 10k ops] Array.find: ${timeFind.toFixed(2)} ms | Map: ${timeMap.toFixed(2)} ms`,
      );
    }
  });
});
