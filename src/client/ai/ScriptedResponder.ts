/**
 * FR4 scripted demo mode: presenter-controlled, clearly labelled fixed
 * responses when a live pipeline is unavailable. Providers are unassigned until
 * Gate 2 (§14), so this is the only responder the build currently has.
 *
 * It carries no transcription. What it does track is which humans it actually
 * received audio from, because that is what makes the §12 two-minute cue real:
 * with "Hears me" off, the AI genuinely cannot answer what was said, rather
 * than pretending not to.
 */

export const SCRIPTED_LABEL = "Scripted response — no live AI pipeline";

export interface ScriptedRequest {
  aiId: string;
  askedBy: string;
  /** Nominal turn length, so floor control and barge-in have something to act on. */
  now: number;
}

export interface ScriptedResponse {
  aiId: string;
  askedBy: string;
  /** Always labelled. Simulation must never read as a working pipeline. */
  label: typeof SCRIPTED_LABEL;
  text: string;
  /** False when the AI received nothing from the asker, per FR8 routing. */
  canAnswer: boolean;
  /** Nominal duration of the scripted turn in milliseconds. */
  durationMs: number;
}

const ANSWERS = [
  "Each voice in this room is a separate Media over QUIC track. I am subscribed to the ones I have been given consent for, and nothing else.",
  "I publish one track and the relay fans it out. My uplink cost does not change as more of you subscribe.",
  "I only generate when I am addressed directly. I heard the last exchange and stayed silent because none of it was addressed to me.",
  "The relay is routing named objects. It is not mixing anything, and it does not know which of us is a person.",
];

export class ScriptedResponder {
  /** aiId → humanId → count of utterances received while consent was on. */
  private heard = new Map<string, Map<string, number>>();
  private nextAnswer = 0;

  /** Called when an object arrives from a human this AI is subscribed to. */
  noteHeardUtterance(aiId: string, humanId: string): void {
    let perHuman = this.heard.get(aiId);
    if (!perHuman) {
      perHuman = new Map<string, number>();
      this.heard.set(aiId, perHuman);
    }
    perHuman.set(humanId, (perHuman.get(humanId) ?? 0) + 1);
  }

  /**
   * Called when consent is withdrawn. What the AI heard before is not erased,
   * but the demo asks about the period after the change, so the counter for
   * that pair restarts.
   */
  resetHeard(aiId: string, humanId: string): void {
    this.heard.get(aiId)?.set(humanId, 0);
  }

  utterancesHeard(aiId: string, humanId: string): number {
    return this.heard.get(aiId)?.get(humanId) ?? 0;
  }

  respond(request: ScriptedRequest): ScriptedResponse {
    const heard = this.utterancesHeard(request.aiId, request.askedBy);
    if (heard === 0) {
      return {
        aiId: request.aiId,
        askedBy: request.askedBy,
        label: SCRIPTED_LABEL,
        text: "I did not receive your audio, so I cannot tell you what was said. My subscription to your track is off.",
        canAnswer: false,
        durationMs: 2_600,
      };
    }
    const text = ANSWERS[this.nextAnswer % ANSWERS.length] ?? ANSWERS[0] ?? "";
    this.nextAnswer += 1;
    return {
      aiId: request.aiId,
      askedBy: request.askedBy,
      label: SCRIPTED_LABEL,
      text,
      canAnswer: true,
      durationMs: 4_200,
    };
  }

  clear(): void {
    this.heard.clear();
    this.nextAnswer = 0;
  }
}
