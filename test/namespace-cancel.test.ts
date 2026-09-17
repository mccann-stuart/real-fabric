import { describe, expect, it } from "vitest";
import { MoqTransportAdapter } from "../src/client/transport/MoqTransportAdapter";

describe("MoqTransportAdapter namespace cancellation", () => {
  it("starts every namespace cancellation before waiting for completion", async () => {
    const adapter = new MoqTransportAdapter();
    const internal = adapter as unknown as {
      namespaceCancels: Map<string, () => Promise<void>>;
    };
    const namespaces = ["namespace-1", "namespace-2", "namespace-3"];
    const started: string[] = [];
    let release!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    for (const namespace of namespaces) {
      internal.namespaceCancels.set(namespace, async () => {
        started.push(namespace);
        await cancellationGate;
      });
    }

    const closePromise = adapter.close("test complete");

    expect(started).toEqual(namespaces);
    release();
    await expect(closePromise).resolves.toBeUndefined();
    expect(internal.namespaceCancels.size).toBe(0);
  });
});
