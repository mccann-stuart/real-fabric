import { AI_TO_AI_TURN_CAP, BARGE_IN_BUDGET_MS } from "../../shared/contracts";

/**
 * H5, H6 and H10, as one state machine with an injected clock so every
 * invariant is testable without a live pipeline.
 *
 * The rules it exists to enforce:
 *  - an AI generates only in response to its own address; ambient conversation
 *    produces nothing (H5);
 *  - one AI publishes at a time, the next one waits and shows Thinking (FR4);
 *  - a human onset stops the addressed AI, closes its group and reports the
 *    measured latency (H6);
 *  - an AI never addresses another AI unless a presenter enabled it, and then
 *    only up to a hard cap (H10).
 */

/** §4.2: the mechanism is chosen at Gate 2 from live comparison. */
export type AddressMechanism = "hold_to_ask" | "wake_name";

export interface AiTurn {
  aiId: string;
  /** One group per turn, so cancelling the group cancels the turn (§6.3). */
  groupId: number;
  startedAt: number;
  addressedBy: string;
  origin: "human" | "ai";
  mechanism: AddressMechanism;
}

export type AddressOutcome =
  | { result: "speaking"; turn: AiTurn }
  | { result: "queued"; position: number }
  | {
      result: "refused";
      reason: "unknown_ai" | "unavailable" | "ai_to_ai_disabled" | "turn_cap" | "suspended";
    };

export interface BargeInResult {
  aiId: string;
  groupId: number;
  onsetAt: number;
  stoppedAt: number;
  latencyMs: number;
  /** H6: the 300 ms budget, measured rather than asserted. */
  withinBudget: boolean;
}

export interface AiDirectorOptions {
  now?: () => number;
  turnCap?: number;
  /** FR4: concurrent AI speech is a presenter option, off by default. */
  allowConcurrentSpeech?: boolean;
}

interface AiRecord {
  aiId: string;
  available: boolean;
  mechanism: AddressMechanism;
}

export class AiDirector {
  private readonly now: () => number;
  private readonly turnCap: number;
  private ais = new Map<string, AiRecord>();
  private current: AiTurn | null = null;
  private queue: Array<{ aiId: string; addressedBy: string; origin: "human" | "ai" }> = [];
  private nextGroupId = 1;
  private aiToAiEnabled = false;
  private consecutiveAiTurns = 0;
  private cappedAt: number | null = null;
  private allowConcurrentSpeech: boolean;
  /** FR4: humans whose track is reconnecting. AIs wait rather than guess. */
  private suspendedHumans = new Set<string>();
  private bargeIns: BargeInResult[] = [];

  constructor(options: AiDirectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.turnCap = options.turnCap ?? AI_TO_AI_TURN_CAP;
    this.allowConcurrentSpeech = options.allowConcurrentSpeech ?? false;
  }

  register(aiId: string, mechanism: AddressMechanism = "hold_to_ask"): void {
    this.ais.set(aiId, { aiId, available: true, mechanism });
  }

  forget(aiId: string): void {
    this.ais.delete(aiId);
    this.queue = this.queue.filter((entry) => entry.aiId !== aiId);
    if (this.current?.aiId === aiId) this.current = null;
  }

  setAvailable(aiId: string, available: boolean): void {
    const record = this.ais.get(aiId);
    if (!record) return;
    record.available = available;
    if (!available) this.forgetTurnsFor(aiId);
  }

  /**
   * H5: the only way an AI speaks. Nothing else in the build starts a turn, so
   * ambient conversation cannot produce one.
   */
  address(aiId: string, addressedBy: string, origin: "human" | "ai" = "human"): AddressOutcome {
    const record = this.ais.get(aiId);
    if (!record) return { result: "refused", reason: "unknown_ai" };
    if (!record.available) return { result: "refused", reason: "unavailable" };

    if (origin === "ai") {
      if (!this.aiToAiEnabled) return { result: "refused", reason: "ai_to_ai_disabled" };
      if (this.consecutiveAiTurns >= this.turnCap) {
        this.cappedAt = this.now();
        return { result: "refused", reason: "turn_cap" };
      }
    }
    if (origin === "human" && this.suspendedHumans.has(addressedBy)) {
      return { result: "refused", reason: "suspended" };
    }

    // A human turn breaks the chain, so the cap counts consecutive AI turns.
    if (origin === "human") {
      this.consecutiveAiTurns = 0;
      this.cappedAt = null;
    } else {
      this.consecutiveAiTurns += 1;
    }

    if (this.current && !this.allowConcurrentSpeech) {
      if (this.current.aiId === aiId) return { result: "speaking", turn: this.current };
      if (!this.queue.some((entry) => entry.aiId === aiId)) {
        this.queue.push({ aiId, addressedBy, origin });
      }
      return {
        result: "queued",
        position: this.queue.findIndex((entry) => entry.aiId === aiId) + 1,
      };
    }

    const turn: AiTurn = {
      aiId,
      groupId: this.nextGroupId++,
      startedAt: this.now(),
      addressedBy,
      origin,
      mechanism: record.mechanism,
    };
    this.current = turn;
    return { result: "speaking", turn };
  }

  /**
   * H6: called on detected onset from any human the speaking AI is subscribed
   * to. Returns the measurement, or null when no AI was speaking.
   */
  bargeIn(onsetAt: number = this.now()): BargeInResult | null {
    const turn = this.current;
    if (!turn) return null;
    const stoppedAt = this.now();
    const latencyMs = Math.max(0, stoppedAt - onsetAt);
    const result: BargeInResult = {
      aiId: turn.aiId,
      groupId: turn.groupId,
      onsetAt,
      stoppedAt,
      latencyMs,
      withinBudget: latencyMs <= BARGE_IN_BUDGET_MS,
    };
    this.bargeIns = [result, ...this.bargeIns].slice(0, 20);
    this.current = null;
    // An interruption is a human turn: it resets the AI-to-AI chain and clears
    // anything queued behind the interrupted answer.
    this.queue = [];
    this.consecutiveAiTurns = 0;
    return result;
  }

  /** Normal end of turn. Grants the floor to whoever queued behind it. */
  endTurn(aiId: string): AiTurn | null {
    if (this.current?.aiId !== aiId) return null;
    this.current = null;
    return this.promote();
  }

  private promote(): AiTurn | null {
    for (;;) {
      const next = this.queue.shift();
      if (!next) return null;
      const record = this.ais.get(next.aiId);
      if (!record?.available) continue;
      const turn: AiTurn = {
        aiId: next.aiId,
        groupId: this.nextGroupId++,
        startedAt: this.now(),
        addressedBy: next.addressedBy,
        origin: next.origin,
        mechanism: record.mechanism,
      };
      this.current = turn;
      return turn;
    }
  }

  /** H10: a presenter action, and it resets the counter either way. */
  setAiToAi(enabled: boolean): void {
    this.aiToAiEnabled = enabled;
    this.consecutiveAiTurns = 0;
    this.cappedAt = null;
  }

  setConcurrentSpeech(allowed: boolean): void {
    this.allowConcurrentSpeech = allowed;
  }

  suspendHuman(humanId: string): void {
    this.suspendedHumans.add(humanId);
  }

  resumeHuman(humanId: string): void {
    this.suspendedHumans.delete(humanId);
  }

  get speaking(): AiTurn | null {
    return this.current;
  }

  /** AI ids waiting, in order. Each of these shows Thinking. */
  get waiting(): string[] {
    return this.queue.map((entry) => entry.aiId);
  }

  get aiToAi(): {
    enabled: boolean;
    consecutiveTurns: number;
    turnCap: number;
    cappedAt: number | null;
  } {
    return {
      enabled: this.aiToAiEnabled,
      consecutiveTurns: this.consecutiveAiTurns,
      turnCap: this.turnCap,
      cappedAt: this.cappedAt,
    };
  }

  get recentBargeIns(): BargeInResult[] {
    return [...this.bargeIns];
  }

  private forgetTurnsFor(aiId: string): void {
    this.queue = this.queue.filter((entry) => entry.aiId !== aiId);
    if (this.current?.aiId === aiId) {
      this.current = null;
      this.promote();
    }
  }
}
