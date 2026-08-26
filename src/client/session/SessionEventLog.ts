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

export interface SessionEventStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class SessionEventLog {
  private events: SessionEvent[] = [];

  constructor(
    private readonly storageKey?: string,
    private readonly storage: SessionEventStorage | null = storageKey ? browserStorage() : null,
  ) {
    this.events = this.restore();
  }

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
    this.persist();
    return event;
  }

  list(): SessionEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
    if (!this.storageKey || !this.storage) return;
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      // The inspector remains usable when browser storage is disabled.
    }
  }

  private restore(): SessionEvent[] {
    if (!this.storageKey || !this.storage) return [];
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isSessionEvent).slice(0, RETAINED_EVENTS);
    } catch {
      return [];
    }
  }

  private persist(): void {
    if (!this.storageKey || !this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.events));
    } catch {
      // Session storage can be unavailable or full; live inspection continues.
    }
  }
}

function browserStorage(): SessionEventStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<SessionEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.at === "number" &&
    typeof event.kind === "string" &&
    (event.subject === null || typeof event.subject === "string") &&
    typeof event.detail === "string" &&
    typeof event.simulated === "boolean"
  );
}
