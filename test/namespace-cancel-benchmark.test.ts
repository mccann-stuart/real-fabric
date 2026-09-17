import { describe, expect, it, vi } from "vitest";
import { MoqTransportAdapter } from "../src/client/transport/MoqTransportAdapter";

describe("MoqTransportAdapter namespace cancellation benchmark", () => {
  it("measures close time with 20 registered namespace cancels", async () => {
    const numCancels = 20;
    const runs = 20;
    const cancelDelayMs = 2; // Simulate async network/control cancel latency per namespace

    let totalMs = 0;

    for (let r = 0; r < runs; r++) {
      const adapter = new MoqTransportAdapter();
      const internal = adapter as unknown as {
        namespaceCancels: Map<string, () => Promise<void>>;
      };

      for (let i = 0; i < numCancels; i++) {
        const cancelFn = vi
          .fn()
          .mockImplementation(
            () => new Promise<void>((resolve) => setTimeout(resolve, cancelDelayMs)),
          );
        internal.namespaceCancels.set(`namespace-${i}`, cancelFn);
      }

      const start = performance.now();
      await adapter.close("benchmark test");
      const duration = performance.now() - start;
      totalMs += duration;

      expect(internal.namespaceCancels.size).toBe(0);
    }

    const avgMs = totalMs / runs;
    console.log(
      `[BENCHMARK] MoqTransportAdapter.close with ${numCancels} namespaces (${cancelDelayMs}ms delay each): avg ${avgMs.toFixed(2)} ms per call across ${runs} runs`,
    );
  }, 30000);
});
