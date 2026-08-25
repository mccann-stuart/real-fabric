/**
 * H15: a value the client cannot observe must read "Not exposed", never zero.
 *
 * Making that a type rather than a convention is deliberate. A bare `number`
 * defaulting to 0 is indistinguishable from a measured 0, and the demo's whole
 * claim rests on the audience trusting the figures on screen.
 */

export const NOT_EXPOSED = "Not exposed" as const;
export type NotExposed = typeof NOT_EXPOSED;

export type Measurement<T> = { exposed: true; value: T } | { exposed: false; reason: string };

export function measured<T>(value: T): Measurement<T> {
  return { exposed: true, value };
}

export function notExposed<T>(reason: string): Measurement<T> {
  return { exposed: false, reason };
}

/** Wraps a value that is only sometimes available, without inventing a zero. */
export function fromNullable<T>(
  value: T | null | undefined,
  reason: string,
): Measurement<NonNullable<T>> {
  return value === null || value === undefined ? notExposed(reason) : measured(value);
}

export function formatMeasurement<T>(
  measurement: Measurement<T>,
  format: (value: T) => string = String,
): string {
  return measurement.exposed ? format(measurement.value) : NOT_EXPOSED;
}

export function formatMilliseconds(measurement: Measurement<number>): string {
  return formatMeasurement(measurement, (value) => `${Math.round(value)} ms`);
}

export function formatCount(measurement: Measurement<number>): string {
  return formatMeasurement(measurement, (value) => value.toLocaleString("en-GB"));
}

export function formatRate(measurement: Measurement<number>, unit: string): string {
  return formatMeasurement(measurement, (value) => `${value.toFixed(1)} ${unit}`);
}

/** Reads the value for arithmetic, or the supplied fallback. Never renders. */
export function valueOr<T>(measurement: Measurement<T>, fallback: T): T {
  return measurement.exposed ? measurement.value : fallback;
}
