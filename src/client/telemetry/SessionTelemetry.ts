import type { Measurement } from "../../shared/measurement";
import { NOT_EXPOSED } from "../../shared/measurement";
import type { ObjectRateSample } from "./ObjectRateWindow";

/**
 * FR6: correlation ids, timings, counts, routing changes, barge-in latency,
 * degradation steps, reconnects and errors — and an exported sanitised JSON
 * report.
 *
 * AC-14 is the constraint that shapes this file: the export must contain no
 * audio, transcript, token, display name or device label. Nothing here accepts
 * free text from a participant, and the export is filtered again on the way
 * out so a future caller cannot smuggle one in.
 */

export interface TelemetryEvent {
  at: number;
  type: string;
  /** Opaque participant id only. Never a display name. */
  participantId?: string;
  trackId?: string;
  value?: number | string;
}

/**
 * The only fields that may reach an export. An allow-list, not a deny-list: a
 * deny-list can exclude only the key names someone anticipated, and it read
 * top-level keys alone, so an unlisted or nested payload carried identifying
 * content straight through.
 */
const PERMITTED_KEYS: ReadonlySet<string> = new Set([
  "at",
  "type",
  "participantId",
  "trackId",
  "value",
]);

const RETAINED_EVENTS = 2_000;
const RETAINED_RATE_SAMPLES = 1_200;

type TimedObjectRateSample = ObjectRateSample & { at: number };

export class SessionTelemetry {
  readonly correlationId = crypto.randomUUID();
  private events: TelemetryEvent[] = [];
  private measurements = new Map<string, Measurement<number | boolean>>();
  private objectRateSamples: TimedObjectRateSample[] = [];

  record(event: Omit<TelemetryEvent, "at">): void {
    this.events.push({ ...sanitiseEvent(event), at: Date.now() });
    // Bounded: a ten-minute run at the reference composition must not grow
    // without limit any more than the audio buffers may (H13).
    if (this.events.length > RETAINED_EVENTS) {
      this.events = this.events.slice(-RETAINED_EVENTS);
    }
  }

  /** H15: measurements keep their exposure state into the export. */
  recordMeasurement(key: string, measurement: Measurement<number | boolean>): void {
    this.measurements.set(key, measurement);
  }

  /** One numeric interval per sample, bounded to a full 20-minute room at 1 Hz. */
  recordObjectRateSample(sample: ObjectRateSample): void {
    if (!validObjectRateSample(sample)) return;
    this.objectRateSamples.push({
      at: Date.now(),
      connection: sample.connection,
      intervalMs: sample.intervalMs,
      publishedObjects: sample.publishedObjects,
      subscribedObjects: sample.subscribedObjects,
      publishedObjectsPerSecond: sample.publishedObjectsPerSecond,
      subscribedObjectsPerSecond: sample.subscribedObjectsPerSecond,
    });
    if (this.objectRateSamples.length > RETAINED_RATE_SAMPLES) {
      this.objectRateSamples = this.objectRateSamples.slice(-RETAINED_RATE_SAMPLES);
    }
  }

  report(roomId: string): Record<string, unknown> {
    return {
      format: "real-fabric-session-v1",
      correlationId: this.correlationId,
      roomId,
      exportedAt: Date.now(),
      excludes: ["audio", "transcripts", "credentials", "display names", "device labels"],
      measurements: Object.fromEntries(
        [...this.measurements].map(([key, measurement]) => [
          key,
          measurement.exposed ? measurement.value : NOT_EXPOSED,
        ]),
      ),
      // Rebuild each row from numeric fields only, including after retention.
      objectRateSamples: this.objectRateSamples
        .filter((sample) => Number.isSafeInteger(sample.at) && validObjectRateSample(sample))
        .map((sample) => ({
          at: sample.at,
          connection: sample.connection,
          intervalMs: sample.intervalMs,
          publishedObjects: sample.publishedObjects,
          subscribedObjects: sample.subscribedObjects,
          publishedObjectsPerSecond: sample.publishedObjectsPerSecond,
          subscribedObjectsPerSecond: sample.subscribedObjectsPerSecond,
        })),
      // Filtered again on the way out, so an event retained before a change to
      // the permitted set cannot leave in an export.
      events: this.events.map((event) => sanitiseEvent(event)),
    };
  }

  export(roomId: string): Blob {
    return new Blob([JSON.stringify(this.report(roomId), null, 2)], {
      type: "application/json",
    });
  }

  clear(): void {
    this.events = [];
    this.measurements.clear();
    this.objectRateSamples = [];
  }
}

function validObjectRateSample(sample: ObjectRateSample): boolean {
  return (
    Number.isSafeInteger(sample.connection) &&
    sample.connection > 0 &&
    Number.isFinite(sample.intervalMs) &&
    sample.intervalMs > 0 &&
    Number.isSafeInteger(sample.publishedObjects) &&
    sample.publishedObjects >= 0 &&
    Number.isSafeInteger(sample.subscribedObjects) &&
    sample.subscribedObjects >= 0 &&
    Number.isFinite(sample.publishedObjectsPerSecond) &&
    sample.publishedObjectsPerSecond >= 0 &&
    Number.isFinite(sample.subscribedObjectsPerSecond) &&
    sample.subscribedObjectsPerSecond >= 0
  );
}

function sanitiseEvent<Event extends Partial<TelemetryEvent>>(event: Event): Event {
  const entries = Object.entries(event).filter(
    ([key, value]) => PERMITTED_KEYS.has(key) && isProtocolValue(value),
  );
  return Object.fromEntries(entries) as Event;
}

/**
 * A value rides along only when it is plainly protocol data. Display names,
 * device labels and transcripts arrive as free text, and whitespace is what
 * separates that from a code, an opaque id or a number.
 */
function isProtocolValue(value: unknown): boolean {
  if (typeof value === "number" || typeof value === "boolean") return true;
  return typeof value === "string" && !/\s/.test(value);
}
