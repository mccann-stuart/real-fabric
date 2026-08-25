/**
 * FR5: retry with bounded exponential backoff and jitter, and show a terminal
 * error with a retry action after 30 seconds.
 *
 * Bounded and terminal both matter on stage. An unbounded retry loop looks
 * identical to a hang, which is the silent failure H14 rules out.
 */

export const TERMINAL_AFTER_MS = 30_000;
const BASE_DELAY_MS = 400;
const MAXIMUM_DELAY_MS = 5_000;

export interface ReconnectionDecision {
  /** False once the terminal deadline has passed; show the retry action. */
  retry: boolean;
  attempt: number;
  delayMs: number;
  elapsedMs: number;
}

export class ReconnectionPolicy {
  private attempt = 0;
  private startedAt: number | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /** Called on each failure. `now` keeps this testable without fake timers. */
  next(now: number): ReconnectionDecision {
    if (this.startedAt === null) this.startedAt = now;
    const elapsedMs = now - this.startedAt;
    if (elapsedMs >= TERMINAL_AFTER_MS) {
      return { retry: false, attempt: this.attempt, delayMs: 0, elapsedMs };
    }

    this.attempt += 1;
    const exponential = Math.min(MAXIMUM_DELAY_MS, BASE_DELAY_MS * 2 ** (this.attempt - 1));
    // Full jitter. Several clients dropped by one relay blip must not return in
    // lockstep and reproduce the failure.
    const delayMs = Math.round(exponential * (0.5 + this.random() * 0.5));
    return { retry: true, attempt: this.attempt, delayMs, elapsedMs };
  }

  /** Called after a successful restore, or when the presenter retries by hand. */
  reset(): void {
    this.attempt = 0;
    this.startedAt = null;
  }

  get attempts(): number {
    return this.attempt;
  }
}
