import { type Measurement, measured, notExposed } from "../../shared/measurement";

/**
 * A session-local arithmetic mean for high-frequency pipeline timings.
 * Invalid samples are ignored so a browser clock anomaly cannot turn an
 * inspector value into NaN or infinity.
 */
export class MeanMetric {
  private samples = 0;
  private total = 0;

  observe(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.samples += 1;
    this.total += value;
  }

  measurement(reason: string): Measurement<number> {
    return this.samples === 0 ? notExposed(reason) : measured(this.total / this.samples);
  }

  reset(): void {
    this.samples = 0;
    this.total = 0;
  }
}
