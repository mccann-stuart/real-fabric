# Milestone 3 — §11.4 Gate 3: multi-agent AI orchestration, floor control and fault isolation

## Context

`README.md:19` says "Milestones 1 and 2 of the §11 release plan are built. Milestones 3 and 4 are not." This plan builds Milestone 3 in code.

Gate 3's subject is autonomous AI participants: deterministic addressing, floor control, barge-in cancellation and loop protection. Much of the *logic* already exists and is unit-tested — `AiDirector` is a complete H5/H6/H10/FR4 state machine, `TrackPlayer` already honours a `cancelled` flag, `AdaptiveJitterBuffer.cancelGroup` already purges a group, and the routing matrix already lives in SQLite. What is missing is the half that makes any of it real:

- **No AI ever publishes audio.** There is exactly one publish call site in the client and it hard-codes the local participant (`RoomSession.ts:786-791`). Every Gate 3 exit criterion — two distinct agents, audible barge-in, no overlap — needs an AI track on the relay.
- **No publisher ever sets `cancelled` or `endOfTurn`.** Both flags exist in the 22-byte header (`frame.ts:9-10`) and the receiver-side purge is wired and tested, but nothing emits them. Barge-in today is purely receiver-local, so it cannot stop a remote listener.
- **Floor control is not authoritative.** Each browser tab runs its own `AiDirector`, and the Durable Object calls are `.catch(() => undefined)` (`RoomSession.ts:864`, `:876`, `:896`) while the local director proceeds regardless.
- **Two of the three Gate 3 failure codes have no raise site.** `ai_pipeline_failed` and `ai_floor_contention` exist in the registry (`failures.ts:23-25`) but are never raised; only `ai_loop_capped` is.

Three live bugs were found while planning, all confirmed in source. They are fixed as part of this work:

1. **Barge-in permanently wedges the floor.** `onHumanOnset` (`RoomSession.ts:831-857`) clears the local turn but never calls `releaseFloor`, so `room_meta.floor_holder` still names the interrupted AI and every later address in that room is denied for the room's life.
2. **Barge-in only cancels the first group of a turn.** `AiTurn.groupId` is minted once per turn, but §6.3 groups roll every second (`RoomSession.ts:769-772`) and scripted turns run 2,600–4,200 ms. Cancelling `turn.groupId` alone leaves the later groups playing.
3. **`requestFloor` re-grants to the current holder.** `room.ts:346` returns `granted: true` when `floor_holder === aiId`, so a second browser addressing an already-speaking AI is told it holds the floor. Related: `setAiPipeline(..., 'unavailable')` (`room.ts:314-330`) never releases the floor, so a failed AI wedges it too.

**Intended outcome:** every Gate 3 deliverable that is not blocked on an external provider decision is code-complete and unit-tested, with the live acceptance evidence recorded as **Outstanding** in the repository's existing wording. Nothing here converts a passing unit test into a live-acceptance claim.

### Decisions taken

| Decision | Choice |
|---|---|
| Scope | Unblocked code build-out. Live recognition/model/synthesis stays behind an interface. |
| AI audio source | Published from the browser, unmistakably labelled as simulation. |
| Wake-name detection | **Out of scope.** §14 assigns it to the UX Lead at Gate 2 exit. `wake_name` stays stored and unread. |
| Floor authority | The Durable Object. The local director acts only on a granted floor. |

### Assumptions, stated rather than assumed silently

- **`MoqTransportAdapter` gains an eighth method, `unpublish(track)`.** §10.4 requires that a pipeline failure "closes that AI's publication track" while humans and other AIs continue; the adapter today offers only whole-session `close()`, which would take the humans down with the AI. `unpublish` is symmetric with the existing `unsubscribe(track)`. This adds one line to the adapter surface enumerated in `PRODUCT_SPEC §6.4` and `AGENTS.md:104-112`; both are updated to match. Per `AGENTS.md:29` this does not materially change user-visible behaviour, security or data handling, so it proceeds without a spec waiver.
- **Routing stays labelled cooperative.** An in-browser AI publisher does *not* make **Hears me** enforced — the driving browser holds one subscription for its own playback, not a separate AI subscription. `MOQ_ROUTING_ENFORCEMENT=cooperative` is unchanged and the UI keeps saying so. Do not let the new publisher become an argument that FR8 is enforced.
- **No `SCHEMA_VERSION` bump.** Every worker change uses existing columns. `migrate()` drops and recreates on a version change (`room.ts:551-552`), which would destroy live rooms' membership, routing consent and `rejoin_hash`. Not worth it.
- **AI first-audio is reported, not gated.** §9.5 lists it explicitly under "Reported, not gated", so its Inspector row carries `"Reported · no gate"` and no Within/Over chip.

---

## Steps

### S1 — Shared contracts and pure helpers

`src/shared/contracts.ts`
- `FLOOR_LEASE_MS = 15_000` — longer than the longest scripted turn (4,200 ms), far shorter than the room lifetime. The reclaim window for a driver that reloaded or died.
- `floorLeaseExpired(floorSince: number | null, now: number): boolean` — pure, so the lease is testable without an injectable clock inside the DO.
- `AiDisplayActivity` gains `"Thinking (Queued)"` (§10.4 names this state).
- `aiDisplayActivity(...)` gains an **optional fifth** parameter `floor?: FloorState`, so the existing four-argument call sites in `invariants.test.ts:522-538` still compile. Returns `"Thinking (Queued)"` when the AI is in `floor.queue` and its pipeline is `thinking`. `Unavailable`, `Not listening to you` and `Partial context` keep precedence, in that order.
- `AiPipelineTimings { aiId; recognitionMs; modelMs; synthesisMs }`, each a `Measurement<number>` — FR4's "recognition, model and synthesis timings separately, per AI" as a shape that is present and honest rather than absent.

`src/shared/latency.ts`
- `percentile(values, p): number | null` — nearest-rank on a sorted copy, `null` below one sample. A measurement primitive, so it belongs here rather than in telemetry.

### S2 — Durable-Object floor authority

`src/worker/room.ts`. No schema change.

`requestFloor` returns `{ granted, reason, room }` with `reason: "granted" | "held" | "already_speaking" | "unavailable" | "lease_reclaimed"`:

1. AI row missing, `state === 'left'`, or `pipeline === 'unavailable'` → `{granted: false, reason: "unavailable"}`, **no enqueue**. This is where §10.4's pipeline failure gates the floor.
2. If `floorLeaseExpired(meta.floor_since, now)` → clear holder, broadcast, fall through.
3. `floor_holder === null` → transition to `aiId`, delete from `floor_queue`, broadcast, grant.
4. `floor_holder === aiId` → `{granted: false, reason: "already_speaking"}`, **no enqueue, no re-grant**. Only the NULL→holder transition grants. Fixes bug 3.
5. Otherwise enqueue, set that AI's pipeline to `thinking`, broadcast, `{granted: false, reason: "held"}`.

`setAiPipeline(..., 'unavailable')` → after the `UPDATE`, call `releaseFloorInternal(aiId, now)` and `DELETE FROM floor_queue WHERE ai_id = ?`. A failed AI must not hold or queue for the floor.

The 20-minute `alarm()` hard stop already sets every AI unavailable and clears the floor; leave it. Client-side termination is S8.

Also: `src/worker/index.ts` floor route passes `reason` through; `src/client/api.ts` `requestFloor` return type gains it.

### S3 — The live-provider seam

New `src/client/ai/AiResponder.ts`:

```ts
export interface AiResponder {
  readonly kind: "scripted" | "live";
  respond(request: AiRespondRequest): Promise<AiRespondResult>;
  noteHeardUtterance(aiId: string, humanId: string): void;
  resetHeard(aiId: string, humanId: string): void;
  clear(): void;
}
```

`AiRespondResult` carries `label: string | null` (a live pipeline sets it null), `text`, `canAnswer`, `durationMs`, `timings: Omit<AiPipelineTimings, "aiId">`, and `audio: AsyncIterable<Float32Array> | null`. Typed as `Float32Array` rather than `AudioData` so the seam does not drag a WebCodecs global into the type surface — the workers test pool has none.

`ScriptedResponder` implements it: `kind = "scripted"`, `label = SCRIPTED_LABEL`, `audio = null`, all three timings `notExposed("No live recognition, model or synthesis provider is configured (§14); the scripted responder performs no inference.")`. `respond` becomes `async`. Its `heard` map and `canAnswer` gating are untouched, so the §12 two-minute cue keeps working exactly as it does now.

Add to `AGENTS.md`, mirroring the existing MOQT boundary rule: **`AiResponder` is the only module permitted to import a recognition, model or synthesis provider SDK.**

### S4 — The scripted voice

New `src/client/ai/ScriptedVoice.ts`.

A deterministic synthetic **beacon**: a two-tone carrier gated by a slow envelope with raised-cosine edges so it does not click. The carrier pair is derived from a hash of `aiId` within a fixed set (392/588, 440/660, 494/741 Hz) so two AIs are distinguishable by ear — which is what "two distinct AI agents" needs. Peak −18 dBFS. Deterministic in `(aiId, turnIndex, frameIndex)`, so tests assert exact samples.

```ts
export const SCRIPTED_VOICE_LABEL =
  "Synthetic tone — no speech is synthesised and no AI pipeline is running";
export class ScriptedVoice {
  constructor(aiId: string);
  /** Exact 960-sample mono frames at 48 kHz; durationMs / 20 of them. */
  frames(durationMs: number, turnIndex: number): Float32Array[];
}
```

**Why a tone.** `AGENTS.md:73` requires that simulation "must never masquerade as a working relay or AI pipeline". A tone cannot be mistaken for a voice. It also needs no production dependency (`AGENTS.md:167`), no provider, no retention terms and no cost ceiling — all three of which are undecided in §14. Rejected: cloud TTS (production dependency plus three undecided §14 rows); `speechSynthesis` (no route into WebCodecs, and a synthetic human voice is precisely the forbidden masquerade); a pre-recorded asset (same masquerade).

Output is plain `Float32Array`, so this file is fully testable in the workers pool.

### S5 — AI audio publication

New `src/client/ai/AiAudioPublisher.ts`. Owns one publication per driven AI and knows nothing about MOQT drafts.

- **Encoder.** One `AudioEncoder` per driven AI, configured from the same exported `probeOpusEncoderSupport()` that `CaptureController.ts:205` already uses, so the AI track carries the identical 48 kHz / mono / 32 kbit/s / 20 ms / DTX-where-echoed configuration as a human track. A `createEncoder` option defaults to WebCodecs; tests inject a fake.
- **Header.** `encodeAudioObject({ participantHash: hashParticipant(aiId), mediaTimestamp, sequence })` — the same 22-byte v1 header. `hashParticipant` is currently module-private at `RoomSession.ts:1675-1682`; **move it to `src/shared/tracks.ts` and export it** (it is a §6.2 track-addressing concern) and import it in both places.
- **Groups.** Same 1-second rule as `publishFrame`. The publisher keeps `turnGroups: number[]` per AI, so `AiTurn.groupId` becomes the *first* group of a turn and barge-in can cancel all of them. Fixes bug 2.
- **Pacing.** A self-scheduling 20 ms loop against the injected clock, so a turn genuinely takes `durationMs` and a barge-in can land mid-turn. A single burst would make barge-in unfalsifiable.
- **Source.** `result.audio` when a responder supplies frames, otherwise `ScriptedVoice.frames(...)`.
- **Draft boundary.** Imports `shared/tracks`, `audio/frame`, `audio/CaptureController`. It never imports `MoqTransportAdapter`; `RoomSession` passes bound `publish`/`unpublish` closures. `AGENTS.md:100` preserved.
- **No local playback shortcut.** The driving browser subscribes to `audio/<aiId>` through the relay like anyone else. A local bypass would make the presenter's own audio sound correct while the relay leg was dead — the masquerade `AGENTS.md` forbids. If the relay will not reflect a publisher's own track, that surfaces honestly through the existing `Waiting for track` card state and becomes a Gate 3 live-verification item.
- **Simulated AIs publish nothing.** `subscribableParticipants` (`RoomSession.ts:1179`) filters `simulated` out entirely, so a simulated AI stays text-only. Only a non-simulated AI publishes. The card must label the two differently (S11) — they are different things.

### S6 — `MoqTransportAdapter.unpublish(track)`

```ts
async unpublish(track: TrackAddress): Promise<void> {
  const key = trackKey(track);
  this.pendingPublications.delete(key);
  const publication = this.publications.get(key);
  if (!publication) return;
  this.publications.delete(key);
  try { publication.controller.close(); } catch { /* transport already dead */ }
}
```

**First implementation task: check `node_modules/moqtail` for a removal counterpart to `addOrUpdateTrack`.** If none exists, closing the `LiveTrackSource` stream ends the subgroup but leaves the alias registered until session close. In that case the honest wording everywhere — Inspector, README, AGENTS.md — is "publication stream closed", not "track unpublished". Do not write the stronger claim without the capability.

### S7 — `AiDirector` acts only on a granted floor

`src/client/ai/AiDirector.ts`:

- New `FloorDecision = { granted: true } | { granted: false; reason: "held" | "already_speaking" | "unavailable" | "unreachable" }`.
- New **pure** `canAddress(aiId, addressedBy, origin)` — extracts the existing unknown-AI / unavailable / `ai_to_ai_disabled` / `turn_cap` / `suspended` checks **without mutating** `consecutiveTurns` or `cappedAt`. `address()` calls it too, so there is one implementation exercised on both paths.
- `address(aiId, addressedBy, origin, floor: FloorDecision)` — the fourth parameter is **required, not defaulted**. A default of `{granted:true}` would recreate the untested path this whole change exists to remove. When `granted === false`, enqueue and return `{result:"queued", position}`, minting no turn. The existing `this.current && !this.allowConcurrentSpeech` guard stays as a second gate covering the presenter's concurrent-speech option, which the DO does not model.
- `endTurn(aiId)` returns `{ next: string | null }` instead of a minted `AiTurn`. Local promotion disappears — the DO promotes on `releaseFloor` and broadcasts `floor_changed`, and S8 mints from that event. Private `promote()` becomes `nextWaiting()` and stops setting `this.current`; `forgetTurnsFor` drops its `promote()` call.
- `applyFloor(floor: FloorState)` — reconcile the local queue against the DO's, dropping entries the DO no longer lists. The local queue stays the only home for `addressedBy` and `origin`, which the DO does not store.

### S8 — `RoomSession` rewiring

`src/client/session/RoomSession.ts` — the correctness core.

New fields: `aiPublisher: AiAudioPublisher`, `responder: AiResponder = new ScriptedResponder()`, `aiTurns: Map<string, AiTurnTiming>`, `turnGroups: Map<string, number[]>`.

**`address(aiId)`** replaces `:859-892`:
1. `canAddress` first. On refusal, log, and `raise("ai_loop_capped")` for `turn_cap` exactly as today.
2. Ask the DO **before** the director decides. The `.catch(() => undefined)` at `:864` and `:876` is deleted; a rejection becomes `{granted: false, reason: "unreachable"}`.
3. `director.address(aiId, me, "human", decision)`.
4. `queued` → `raise("ai_floor_contention")` (with distinct log text for `"unreachable"`, so the inspector can tell "another AI holds the floor" from "the room service could not be reached"), `setPipeline(aiId, "thinking")`.
5. `speaking` → clear the contention failure, `setPipeline(aiId, "speaking")`, record the turn timing, `await responder.respond(...)`, and — when this browser drives the AI — start `aiPublisher.speak(...)`.

**Driver ownership.** A browser drives an AI only when `options.presenterMode` is true and the AI is not simulated. This is the **first use** of `RoomSessionOptions.presenterMode`, which is currently threaded from `RoomPage.tsx:30` through `useRoomSession.ts:81` into `RoomSession.ts:165` and never read. Combined with the DO's exclusive NULL→holder transition and the 15-second lease, two presenter tabs cannot both drive one track.

**`endTurn(aiId)`** replaces `:894-900`: `director.endTurn` → `aiPublisher.end(aiId)` (emits `endOfTurn: true`, then unpublishes) → `releaseFloor`, raising `ai_floor_contention` on rejection instead of swallowing → `setPipeline(aiId, "listening")`. Do **not** mint `next` locally; the DO promotes and broadcasts.

**`onHumanOnset()`** replaces `:831-857`: `director.bargeIn` → `aiPublisher.cancel(aiId)` (publishes `cancelled: true`) → cancel **every** group in `turnGroups` for that AI, not just `result.groupId` (bug 2) → existing barge-in log and telemetry unchanged → **`releaseFloor`** (bug 1) → `setPipeline(aiId, "interrupted")`.

**`applyEvent`** replaces the collapsed refresh-only case at `:1382-1387`:
- `floor_changed` → apply `holderId` and `queue` to `this.room.floor` immediately, `director.applyFloor(...)`, then `void this.refresh()`. If this browser is the driver and the new holder is in its own local queue, mint the promoted turn with `{granted: true}` and start its publication — this is how §12's 2:25 cue ("second shows Thinking, then speaks") actually completes.
- `ai_pipeline_changed`, `ai_to_ai_changed` → apply the payload, then refresh.
- `routing_changed` → unchanged, refresh-only; it carries no values.

Rationale: these payloads are already on the wire. Discarding them and issuing a full `GET /api/rooms/{code}` puts an HTTP round trip inside the two paths measured against 300 ms and 500 ms budgets. Applying optimistically then refreshing keeps the server authoritative, which is exactly what `AGENTS.md:83` permits.

**`close()`** — insert `await this.aiPublisher.close()` **before** `await this.transport.close(...)`, so every AI encoder is flushed and every AI publication ended while the session is still alive. This is AC-15 and §12's 3:30 cue, and it makes `AGENTS.md:162` ("hard-stop rooms at 20 minutes and terminate their AI pipelines") true rather than aspirational. `applyEvent("room_expired")` already routes to `close()`.

`SessionState` gains `publishedAiIds: string[]` and `responder: "scripted" | "live"`.

### S9 — AI turn telemetry

`AiTurnTiming { aiId; addressedAt; floorGrantedAt; firstObjectAt; endedAt; outcome }`.

`SessionMetrics` additions, all `Measurement<number>`:

| Field | Exposure | Gate |
|---|---|---|
| `aiAddressToFirstAudioMs` | `notExposed` until an AI turn produces an object | `"Reported · no gate"` per §9.5 |
| `aiFloorGrantMs` | `floorGrantedAt - addressedAt` | `"Reported · no gate"` |
| `bargeInSamples` | `director.recentBargeIns.length` | gated at `>= 10` — literally the Gate 3 criterion |
| `bargeInP50Ms`, `bargeInP95Ms` | `notExposed("Fewer than ten interruptions have been recorded in this session; the Gate 3 criterion needs ten.")` below ten | gated at `BARGE_IN_BUDGET_MS`, consistent with the existing single-value row at `Inspector.tsx:482-486` |
| `aiPipelineTimings[]` | one row per AI, carried straight from `AiRespondResult.timings` | `"Reported · no gate"` per §9.5 |

The last row is how FR4 and H15 are satisfied *together*: the per-AI rows exist, and each says **Not exposed** with an exact reason — never zero, never the scripted `durationMs` dressed up as a model latency.

`SessionTelemetry.recordMeasurement` gets its **first call sites** (it currently has none): `barge_in_p50_ms`, `barge_in_p95_ms`, `barge_in_samples`, `ai_address_to_first_audio_ms`. The sanitised export then carries the Gate 3 figures with their exposure state intact. New `{ type: "ai_turn", participantId, value }` events; `FORBIDDEN_KEYS` already strips `text` and `label`, so response content cannot leak (AC-14).

### S10 — Inspector

`src/client/components/Inspector.tsx`, Latency tab, two new `ComparisonTable`s after "Interaction and acceptance latency": **AI turn latency** (address→first audio, floor grant, barge-in p50, barge-in p95, interruptions recorded) and **AI pipeline timings, per AI** (recognition / model / synthesis per AI). Ungated rows pass the literal `"Reported · no gate"` and omit the `withinBudget` predicate, per the established convention. Every pipeline-timing row will render **Not exposed** until a provider exists — that is the point.

`src/client/components/SubscriptionGraph.tsx` — `buildEdges` gains `publishedAiIds`, emitting an `aiId → relay` publication edge per driven AI. Legend gains "AI publication — labelled scripted voice". This gives §11.4's "update the inspector live graph" an AI edge to update.

### S11 — `ParticipantCard`

New **optional** props `floor`, `aiToAi`, `responder`, so `test/participant-card.test.ts` keeps compiling.

- `"Thinking (Queued)"` via the S1 `aiDisplayActivity` change.
- **Fix `slug()`** (`:178-180`): it only collapses whitespace today, so `"Thinking (Queued)"` would produce the invalid class `thinking-(queued)`. Use `.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")` — verified not to change `not-listening-to-you` or `partial-context`.
- **Turn counter.** §10.4 requires "AI card displays *Turn cap reached* with visible turn counter"; today the counter exists only in the presenter-only `PresenterStrip:130-135`. Add `AI-to-AI turns {n} / {cap}` when enabled, and `Turn cap reached` when `cappedAt !== null`. The strip counter stays as presenter health; this one is the audience-visible one §10.4 asks for.
- **Labelling.** A non-simulated scripted AI gets a `Scripted voice` chip with `title={SCRIPTED_VOICE_LABEL}`. The existing `Simulated` chip keeps its meaning: no track at all. The two must read differently.
- Presenter-only `Retry pipeline` button on an `Unavailable` card (§10.4 recovery), wired in S12.

`RoomPage.tsx:173-191` passes `floor`, `aiToAi` and `responder` through.

### S12 — Presenter path to create real AIs

`addAi`/`removeAi` exist in `api.ts:99-118` and `worker/index.ts:195-218` with **no UI caller** — presenters can currently only produce *simulated* AIs. Add an "AI participants" block to `src/client/components/PresenterStrip.tsx`: name input, simulated-vs-scripted-voice selector, `Add AI`; a list with `Remove`; and `Retry pipeline` on an unavailable AI. Copy states the difference plainly, in UK English — *Simulated:* "a labelled participant with no MoQ track"; *Scripted voice:* "a real MoQ track carrying a labelled synthetic tone. There is no live AI pipeline." `RoomPage.tsx:414-439` wires the three handlers.

### S13 — Tests

New `test/milestone-3-ai.test.ts`, following the established conventions exactly: opening block comment `/** §11.4 milestone 3: multi-agent AI orchestration, floor control and fault isolation. */`, `describe("M3 — <deliverable>")` blocks, lower-case behavioural `it()` sentences, inline comments citing the requirement ID.

- **M3 — durable-object floor authority** (`SELF.fetch`, rotating `cf-connecting-ip` per the existing idiom): grants to the first AI and queues the second; **refuses** a second request from the current holder rather than re-granting (bug 3); release promotes the queue head; refuses the floor to an `unavailable` AI; releases and promotes when the holder goes unavailable; `floorLeaseExpired` reclaims a stale hold — asserted against the **pure helper**, because the DO calls `Date.now()` directly and clock control around DO alarms is unreliable in the workers pool.
- **M3 — addressing acts only on a granted floor**: `{granted:false}` queues and mints nothing; `{granted:true}` mints; `ai_floor_contention` is raised when the floor call **rejects** and when it returns `granted:false`, and clears on a later grant; `endTurn` releases and mints nothing locally; **barge-in releases the floor** (bug 1 regression); barge-in cancels every group the turn touched (bug 2 regression).
- **M3 — publisher cancellation and end-of-turn markers**: `cancel()` publishes an object whose decoded metadata has `cancelled: true` and nothing after it; it also marks the previous group when a 200 ms buffer could still hold it; `end()` publishes `endOfTurn: true` then unpublishes that track and no other; a `TrackPlayer` fed a `cancelled` object **through `accept`** purges the group — driving the existing `:91-93` branch end to end rather than calling `cancelGroup` directly.
- **M3 — labelled scripted AI voice**: exactly `durationMs / 20` frames of 960 samples; byte-identical for the same `(aiId, turnIndex)` and different across `aiId`s; non-silent with peak below full scale; `ScriptedResponder` satisfies `AiResponder` with all three timings `exposed === false` and a reason naming §14.
- **M3 — fault isolation**: a publisher error raises `ai_pipeline_failed`, marks only that AI unavailable, unpublishes only that track, and leaves human capture and the other AI untouched; the registry entry is `degraded` and non-blocking (asserted against `failures.ts`, so copy and behaviour cannot drift); `close()` unpublishes every AI track **before** closing the transport, asserted on call order (AC-15); `room_expired` closes the session.
- **M3 — AI turn telemetry**: address→first-audio Not exposed before any object, measured after; `percentile` correct for a known array and `null` when empty; barge-in p50/p95 Not exposed at nine samples with a reason naming ten, measured at ten; every AI has a pipeline-timings row, all three Not exposed with the §14 reason; the sanitised export carries the percentile measurements and no `text` or `label` key.
- **M3 — display**: `"Thinking (Queued)"` for a queued AI, `"Thinking"` for the holder, with `Unavailable` and `Not listening to you` still taking precedence; `buildEdges` draws a publication edge for a driven AI and none for a simulated one; `ParticipantCard` renders the turn counter, `Turn cap reached` and the `Scripted voice` chip, via `renderToStaticMarkup` per the existing file's idiom.

**Existing files to extend:** `test/invariants.test.ts:245-330` (six `AiDirector` cases gain the required `FloorDecision` argument; `endTurn` assertion updated; one new queue-without-grant case); `test/room-service.test.ts` (floor authority, `addAi` with `simulated: false`); `test/audio-frame.test.ts` (round-trip with both flags set, and a zero-length payload); `test/participant-card.test.ts`; `test/worker.test.ts` (a standing guard that `SCHEMA_VERSION` was not bumped).

**Harness constraints that shaped S4 and S5:** the whole suite runs in `@cloudflare/vitest-pool-workers`, so there is no DOM (`renderToStaticMarkup` only), no `WebTransport` unless faked per-test with `Object.defineProperty` + `Reflect.deleteProperty` in a `finally`, and **no `AudioEncoder`/`AudioData`**. That is precisely why `ScriptedVoice` emits `Float32Array` and `AiAudioPublisher` takes an injected encoder factory. Without those two seams the publisher would be untestable in this repository.

### S14 — Documentation

Recount tests from the real `pnpm test` output first. Note the **pre-existing drift**: `README.md:127` says 152 across ten files, `AGENTS.md:34` says 144 across ten files, `Standards.md:87` says 152 across ten files, and `test/` holds 17. Reconcile all three.

**`README.md`** — `:9` status paragraph adds Milestone 3 and "no live AI pipeline exists"; `:19` becomes "Milestones 1, 2 and 3 of the §11 release plan are built in code. Milestone 4 is not. Gate 3's live acceptance evidence is outstanding."; H5/H6/H10 rows (`:38`, `:39`, `:43`) gain the DO grant, the publisher markers and the card-visible counter; `:122` layout bullet adds the three new `src/client/ai` modules. **New Milestone 3 table after `:88`**, matching the M1/M2 two-column shape, with rows for the extended director/floor work, publisher cancellation markers, fault isolation and browser AI audio all marked **Built.** with their live caveat, wake-name detection and live providers marked **Not built.** with the §14 owner, and a final bolded **Gate 3 exit … Outstanding.** row.

**"What is not verified" (`:176-195`)** — rewrite, do not delete: `:186` becomes "that a remote browser goes audibly silent within 300 ms of a published cancellation marker. The marker is emitted and the receiver purge is unit-tested, but no relay has carried one." `:190` becomes "milestone 4 of the §11 release plan, and Gate 3's live acceptance evidence: two live AIs, ten addressed exchanges, audible barge-in within 300 ms and live routing changes within 500 ms." `:185` stays verbatim. **New bullet:** "that the AI voice is anything other than a labelled synthetic tone. No speech is synthesised anywhere in this build."

**`AGENTS.md`** — extend `:46` with the browser AI publisher, its labelling, and DO floor authority; add `unpublish(track)` to the boundary block at `:104-112`; add the `AiResponder`-is-the-only-provider-importer rule; append the publisher's cancellation marker to the invariant at `:63`. `:162` needs no wording change — it is now actually true.

**`Standards.md`** — §1 pipeline diagram gains the parallel AI branch (`ScriptedVoice` → WebCodecs Opus, identical configuration → `MoqTransportAdapter` → `audio/<ai-id>`); `:89-96` "Automated tests do not prove" gains "audible AI barge-in across ten interruptions" and "any live recognition, model or synthesis provider".

**`PRODUCT_SPEC_v1-demo_1.md`** — one line in §6.4's adapter list for `unpublish(track)`.

---

## Dependencies

```
S1 ──┬─ S2 ─┐
     ├─ S3 ─┤
     ├─ S4 ─┼─ S5 ─┬─ S8 ─┬─ S9 ─ S10 ─┐
     └─ S7 ─┘      │      └─ S11 ─ S12 ┼─ S13 ─ S14
              S6 ──┘                    ┘
```

S6 first in practice — the `moqtail` capability check gates the honest wording in S5, S8, S10 and S14.

---

## Verification

Run in order. Every command is expected to pass before the next.

```bash
test -L node_modules && readlink node_modules
```

Must print exactly `/Users/mccannstuart/.node_modules` — the `MEMORIES.md` constraint. Stop if it does not.

```bash
pnpm lint && pnpm typecheck
```

```bash
pnpm test
```

Record the real file and test counts from this output for S14. Do not write a count that was not observed.

```bash
pnpm build && pnpm deploy:dry-run
```

Or the whole gate at once:

```bash
pnpm check
```

**Manual browser verification** of what unit tests cannot reach. Start the dev server via the Browser pane (`preview_start`, never Bash), open a room in presenter mode, and confirm by reading the page and the console:

1. Add a **scripted voice** AI. Its card shows the `Scripted voice` chip, and the Inspector graph gains an `aiId → relay` publication edge.
2. Hold to ask it. The card moves to **Speaking**; the Inspector's *Address → first audio* row leaves **Not exposed**.
3. Address a second AI while the first speaks. It shows **Thinking (Queued)**, the first keeps the floor, and `ai_floor_contention` appears as a transient failure.
4. Speak over the answer. The card reads **Interrupted**, the barge-in row populates, and `interruptions recorded` increments. After ten, p50 and p95 leave **Not exposed**.
5. Turn **Hears me** off, keep talking, then ask what was said. The graph edge goes dashed, the card reads **Partial context**, and the AI answers that it did not receive the audio. Confirm the enforcement footnote still says *cooperative*.
6. Set an AI unavailable via `Retry pipeline`'s inverse. Only that AI's card goes **Unavailable**, its publication edge disappears, the floor is released, and human capture and the other AI are unaffected.
7. Leave. Confirm on the console that every AI publication ended **before** the transport closed.

**What this does not verify, and must not be recorded as verified:** that a *remote* browser hears the AI, goes silent within 300 ms of a cancellation marker, or that any of it works against a real relay — `MOQT_TRANSPORT_VERIFIED` is still `false`. All of that is Gate 3 acceptance evidence and stays **Outstanding.**

---

## Out of scope

- Live recognition, model or synthesis providers, and their retention terms and per-room cost ceiling — §14, owned by the Product Owner. `AiResponder` is the seam; nothing plugs into it here.
- Wake-name detection — §14, owned by the UX Lead at Gate 2 exit.
- An out-of-browser AI worker over raw QUIC or WebTransport — §14, owned by the AI Lead at Gate 1; also blocked by the known P1, since no AI row has a usable plaintext credential and every mutation is gated behind `assertHuman`.
- The shared relay-credential P1 and any move from cooperative to enforced routing — Gate 1.
- Milestone 4 (§11.5): hybrid discovery, rejoin and capacity scaling.
