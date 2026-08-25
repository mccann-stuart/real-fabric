/**
 * §4.3: the inspector shows timestamped connect, publish, subscribe,
 * unsubscribe, first-object, routing-change, barge-in, reconnect and close
 * events.
 *
 * Bounded, and it never carries a display name, credential or transcript —
 * FR6 forbids those, and this log is what the sanitised export is built from.
 */

export type SessionEventKind =
  | "connect"
  | "publish"
  | "subscribe"
  | "unsubscribe"
  | "first_object"
  | "routing_change"
  | "barge_in"
  | "reconnect"
  | "degradation"
  | "drift"
  /** §10.5: a concealed gap, counted and named rather than played as a hole. */
  | "concealment"
  /** §11.3: audio input devices appearing or disappearing. Counts, never labels. */
  | "device"
  | "failure"
  | "simulation"
  | "close";

export interface SessionEvent {
  id: string;
  at: number;
  kind: SessionEventKind;
  /** Opaque identifiers only. */
  subject: string | null;
  detail: string;
  /** True where the line describes presenter simulation, not live transport. */
  simulated: boolean;
}

const RETAINED_EVENTS = 200;
const DUPLICATE_FAILURE_WINDOW_MS = 1_000;

export class SessionEventLog {
  private events: SessionEvent[] = [];

  record(
    kind: SessionEventKind,
    detail: string,
    options: { subject?: string; simulated?: boolean; at?: number } = {},
  ): SessionEvent {
    const at = options.at ?? Date.now();
    const previous = this.events[0];
    if (
      kind === "failure" &&
      previous?.kind === kind &&
      previous.detail === detail &&
      previous.subject === (options.subject ?? null) &&
      at - previous.at < DUPLICATE_FAILURE_WINDOW_MS
    ) {
      return previous;
    }
    const event: SessionEvent = {
      id: crypto.randomUUID(),
      at,
      kind,
      subject: options.subject ?? null,
      detail,
      simulated: options.simulated ?? false,
    };
    this.events = [event, ...this.events].slice(0, RETAINED_EVENTS);
    return event;
  }

  list(): SessionEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
