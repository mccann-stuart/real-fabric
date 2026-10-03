import { type Measurement, measured, notExposed } from "../../shared/measurement";

export interface ObjectTotals {
  publishedObjects: number;
  subscribedObjects: number;
}

export interface ObjectRateSample {
  connection: number;
  intervalMs: number;
  publishedObjects: number;
  subscribedObjects: number;
  publishedObjectsPerSecond: number;
  subscribedObjectsPerSecond: number;
}

const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 5_000;
const NO_RATE = "A complete live object-rate interval has not been observed yet.";

/**
 * Recent rates use deltas from the same transport connection. The adapter's
 * object totals span reconnects, so dividing them by the latest connection's
 * age would make the inspector and benchmark rates falsely jump after recovery.
 */
export class ObjectRateWindow {
  private connection = 0;
  private previous: (ObjectTotals & { at: number }) | null = null;
  private publishedRate: Measurement<number> = notExposed(NO_RATE);
  private subscribedRate: Measurement<number> = notExposed(NO_RATE);

  beginConnection(at: number, totals: ObjectTotals): void {
    this.connection += 1;
    this.rebase(at, totals);
  }

  stop(): void {
    this.previous = null;
    this.publishedRate = notExposed("The live transport is not connected.");
    this.subscribedRate = notExposed("The live transport is not connected.");
  }

  observe(at: number, totals: ObjectTotals): ObjectRateSample | null {
    const previous = this.previous;
    if (!previous) return null;
    const intervalMs = at - previous.at;
    const publishedObjects = totals.publishedObjects - previous.publishedObjects;
    const subscribedObjects = totals.subscribedObjects - previous.subscribedObjects;
    if (
      !Number.isFinite(intervalMs) ||
      intervalMs < 0 ||
      intervalMs > MAX_INTERVAL_MS ||
      !Number.isFinite(publishedObjects) ||
      !Number.isFinite(subscribedObjects) ||
      publishedObjects < 0 ||
      subscribedObjects < 0
    ) {
      // A suspended timer or regressed counter cannot establish a recent rate.
      this.rebase(at, totals);
      return null;
    }
    if (intervalMs < MIN_INTERVAL_MS) return null;

    const sample = {
      connection: this.connection,
      intervalMs,
      publishedObjects,
      subscribedObjects,
      publishedObjectsPerSecond: (publishedObjects * 1_000) / intervalMs,
      subscribedObjectsPerSecond: (subscribedObjects * 1_000) / intervalMs,
    };
    this.previous = { at, ...totals };
    this.publishedRate = measured(sample.publishedObjectsPerSecond);
    this.subscribedRate = measured(sample.subscribedObjectsPerSecond);
    return sample;
  }

  publishedObjectsPerSecond(): Measurement<number> {
    return this.publishedRate;
  }

  subscribedObjectsPerSecond(): Measurement<number> {
    return this.subscribedRate;
  }

  private rebase(at: number, totals: ObjectTotals): void {
    this.previous = { at, ...totals };
    this.publishedRate = notExposed(NO_RATE);
    this.subscribedRate = notExposed(NO_RATE);
  }
}
