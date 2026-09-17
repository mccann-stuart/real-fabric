import { describe, expect, it } from "vitest";

describe("WebSocket close performance benchmark", () => {
  it("measures iteratively closing sockets vs batched/indexed array closing", () => {
    const numSockets = 500;
    const runs = 100;

    interface DummySocket {
      close(code?: number, reason?: string): void;
    }

    let totalIterativeMs = 0;
    let totalOptimizedMs = 0;

    const noopClose = () => {};

    for (let r = 0; r < runs; r++) {
      const sockets: DummySocket[] = new Array(numSockets);
      for (let i = 0; i < numSockets; i++) {
        sockets[i] = { close: noopClose };
      }

      // Baseline: for...of calling close on array
      const startIter = performance.now();
      for (const socket of sockets) {
        socket.close(4001, "room expired");
      }
      totalIterativeMs += performance.now() - startIter;

      const socketsOpt: DummySocket[] = new Array(numSockets);
      for (let i = 0; i < numSockets; i++) {
        socketsOpt[i] = { close: noopClose };
      }

      // Optimized: indexed loop over cached array reference
      const startOpt = performance.now();
      const list = socketsOpt;
      const len = list.length;
      for (let i = 0; i < len; i++) {
        list[i]?.close(4001, "room expired");
      }
      totalOptimizedMs += performance.now() - startOpt;
    }

    const avgIterUs = (totalIterativeMs / runs) * 1000;
    const avgOptUs = (totalOptimizedMs / runs) * 1000;

    console.log(
      `[BENCHMARK] Sockets close (${numSockets} sockets): for..of avg ${avgIterUs.toFixed(2)} µs, for..i avg ${avgOptUs.toFixed(2)} µs per call`,
    );

    expect(numSockets).toBe(500);
  });
});
