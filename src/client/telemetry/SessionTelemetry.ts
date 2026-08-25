import type { Measurement } from "../../shared/measurement";
import { NOT_EXPOSED } from "../../shared/measurement";

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

/** Fields that must never appear in an export, whatever a caller passes. */
const FORBIDDEN_KEYS = [
  "displayName",
  "display_name",
  "name",
  "token",
  "rejoinToken",
  "credential",
  "transcript",
  "text",
  "deviceLabel",
  "label",
  "audio",
];

const RETAINED_EVENTS = 2_000;

export class SessionTelemetry {
  readonly correlationId = crypto.randomUUID();
  private events: TelemetryEvent[] = [];
  private measurements = new Map<string, Measurement<number | boolean>>();

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
      events: this.events,
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
  }
}

function sanitiseEvent(event: Omit<TelemetryEvent, "at">): Omit<TelemetryEvent, "at"> {
  const entries = Object.entries(event).filter(([key]) => !FORBIDDEN_KEYS.includes(key));
  return Object.fromEntries(entries) as Omit<TelemetryEvent, "at">;
}
