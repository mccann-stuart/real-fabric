import type { Participant } from "../../shared/contracts";

/**
 * §4.2: below eight participants, equal cards. Above that, a compact grid
 * ordered by recent speech, with the current and last three speakers held
 * prominent so the view does not churn.
 *
 * The anti-churn rule is the interesting half. Ordering purely by recency
 * reshuffles the grid on every utterance, which is unwatchable on a projector.
 * Holding a small prominent set stable is what makes the layout survive a real
 * conversation.
 */

export const COMPACT_THRESHOLD = 8;
export const PROMINENT_SPEAKERS = 4;

export type RoomLayout = "equal" | "compact";

export interface LayoutResult {
  layout: RoomLayout;
  /** Rendered first and larger. Contains the viewer plus recent speakers. */
  prominent: Participant[];
  rest: Participant[];
}

export function layoutParticipants(
  participants: readonly Participant[],
  viewerId: string,
  /** Ids held prominent from the previous render, to damp reshuffling. */
  previousProminent: readonly string[] = [],
): LayoutResult {
  const active = participants.filter((participant) => participant.state !== "left");
  if (active.length < COMPACT_THRESHOLD) {
    return { layout: "equal", prominent: active, rest: [] };
  }

  const byRecency = [...active].sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  const viewer = active.find((participant) => participant.id === viewerId);
  const prominent: Participant[] = viewer ? [viewer] : [];
  const taken = new Set(prominent.map((participant) => participant.id));

  // Performance optimization (⚡ Bolt): Build a Map for O(1) candidate lookup instead of
  // O(N) array search inside previousProminent loop.
  const activeMap = new Map<string, Participant>();
  for (let index = 0; index < byRecency.length; index += 1) {
    const item = byRecency[index];
    if (item) activeMap.set(item.id, item);
  }

  // Keep whoever was already prominent and is still recent, before admitting
  // anyone new. This is the churn damping.
  for (const id of previousProminent) {
    if (prominent.length >= PROMINENT_SPEAKERS) break;
    if (taken.has(id)) continue;
    const candidate = activeMap.get(id);
    if (candidate) {
      prominent.push(candidate);
      taken.add(id);
    }
  }
  for (const candidate of byRecency) {
    if (prominent.length >= PROMINENT_SPEAKERS) break;
    if (taken.has(candidate.id)) continue;
    prominent.push(candidate);
    taken.add(candidate.id);
  }

  return {
    layout: "compact",
    prominent,
    // §4.2: every participant stays reachable; nobody is hidden behind a menu.
    rest: byRecency.filter((participant) => !taken.has(participant.id)),
  };
}
