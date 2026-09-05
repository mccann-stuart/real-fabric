/**
 * FR3 and H12: prevent duplicate playback after reconnect or reload using
 * participant, group and object identifiers.
 *
 * A reload inside the rejoin window resubscribes from a position the previous
 * session had already played. Without this, the demo's most visible moment —
 * the presenter reloading on stage — plays the last second of every track
 * twice.
 */

/** One group is one second of audio (§6.3), so this is a few seconds of memory. */
const RETAINED_GROUPS_PER_PARTICIPANT = 4;
/** Maximum object IDs retained per group (e.g. ~500 objects per 1-second group, where normal cadence is 50/s) to prevent unbounded memory growth (CWE-770 / DoS). */
const MAX_OBJECTS_PER_GROUP = 500;

export class PlaybackDeduplicator {
  private seen = new Map<string, Map<number, Set<number>>>();

  /**
   * Returns true when this object has not been played for this participant and
   * should be handed to the mixer. Returns false for a repeat.
   */
  accept(participantId: string, groupId: number, objectId: number): boolean {
    let groups = this.seen.get(participantId);
    if (!groups) {
      groups = new Map<number, Set<number>>();
      this.seen.set(participantId, groups);
    }

    let objects = groups.get(groupId);
    if (!objects) {
      objects = new Set<number>();
      groups.set(groupId, objects);
      this.prune(groups);
    }

    if (objects.has(objectId)) return false;
    // Security: Limit objects per group to prevent memory exhaustion from flooding object IDs (SEC-09).
    if (objects.size >= MAX_OBJECTS_PER_GROUP) return false;
    objects.add(objectId);
    return true;
  }

  /** Called when a participant leaves for good, so memory does not accumulate. */
  forget(participantId: string): void {
    this.seen.delete(participantId);
  }

  clear(): void {
    this.seen.clear();
  }

  /** Groups currently retained, for the inspector and for tests. */
  retainedGroups(participantId: string): number {
    return this.seen.get(participantId)?.size ?? 0;
  }

  private prune(groups: Map<number, Set<number>>): void {
    if (groups.size <= RETAINED_GROUPS_PER_PARTICIPANT) return;
    const ordered = [...groups.keys()].sort((left, right) => left - right);
    for (const groupId of ordered.slice(0, groups.size - RETAINED_GROUPS_PER_PARTICIPANT)) {
      groups.delete(groupId);
    }
  }
}
