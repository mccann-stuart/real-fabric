# Real Fabric security issues

This document turns the completed Codex Security review into an implementation backlog. It is intended for engineering planning and remediation tracking; it is not a claim that the deployed relay or browser paths have been exploited.

## Evidence baseline

- Scan ID: `57e664f1-aa19-4e8c-a020-d7ef4fe380bc`
- Scanned revision: `a784122aa18c6b7fbee1ae53d34b054a24d71f0b`
- Scan date: 26 August 2026
- Coverage: 93 of 93 authorised files
- Validated findings: 13 — 2 high, 10 medium and 1 low
- Canonical sources: [`report.md`](./report.md), [`findings.json`](./findings.json), [`coverage.json`](./coverage.json) and [`scan-manifest.json`](./scan-manifest.json)

The line numbers and excerpts below are pinned to the scanned revision. This document is based on `origin/main` at `b354dac71c868706a8eca7b40dff233425f63f76`, where later room-UI, MOQT and scan-artifact work has moved some client line numbers. A targeted comparison found no remediation of the controls described here. Re-run the relevant tests and a focused security review before marking an issue closed.

## Priority summary

| Priority | Issue | Severity | Confidence | Primary boundary |
| --- | --- | --- | --- | --- |
| P1 | [SEC-01 — Relay-wide browser bearer](#sec-01--room-creation-and-joining-disclose-a-relay-wide-publishsubscribe-bearer) | High | Medium | Relay authorisation |
| P1 | [SEC-02 — Any human receives presenter authority](#sec-02--any-joined-human-can-execute-presenter-and-ai-lifecycle-controls) | High | High | Room authorisation |
| P2 | [SEC-03 — Unvalidated AI floor target](#sec-03--unvalidated-ai-identifiers-can-wedge-or-pre-empt-the-global-floor) | Medium | High | Shared floor integrity |
| P2 | [SEC-04 — Routing preference disclosure](#sec-04--public-room-snapshots-disclose-every-humans-per-ai-routing-preferences) | Medium | High | Participant privacy |
| P2 | [SEC-05 — Reusable bearer in WebSocket URL](#sec-05--a-reusable-participant-bearer-is-placed-in-the-websocket-query-string) | Medium | Medium | Credential handling |
| P2 | [SEC-06 — Unbounded control sockets](#sec-06--one-participant-token-can-open-unbounded-concurrent-control-sockets) | Medium | High | Durable Object availability |
| P2 | [SEC-07 — Unthrottled room joins](#sec-07--unthrottled-open-room-joins-permit-unbounded-participant-and-routing-allocation) | Medium | High | Durable Object availability |
| P2 | [SEC-08 — Unbounded JSON parsing](#sec-08--worker-parses-unbounded-json-bodies-before-rate-limiting-or-authentication) | Medium | High | Worker availability |
| P2 | [SEC-09 — Unbounded playback deduplication](#sec-09--playback-deduplication-retains-unbounded-object-identifiers-per-group) | Medium | High | Browser memory |
| P2 | [SEC-10 — Unbounded media burst work](#sec-10--media-bursts-trigger-count-unbounded-sorting-and-decoder-submission) | Medium | High | Browser CPU and decoder |
| P2 | [SEC-11 — Unknown room probes create SQLite state](#sec-11--unknown-room-code-probes-initialise-persistent-sqlite-durable-objects) | Medium | High | Cloudflare resource allocation |
| P2 | [SEC-12 — Read-only clients start capture](#sec-12--narrow-read-only-clients-still-start-microphone-capture-and-publication) | Medium | Medium | Microphone privacy |
| P3 | [SEC-13 — Cross-participant activity spoofing](#sec-13--any-participant-can-spoof-another-participants-activity) | Low | High | Presentation integrity |

## Decision principles

- Keep live audio on MOQT over WebTransport and QUIC. None of these fixes should introduce a WebRTC or WebSocket audio fallback.
- Preserve open membership. Abuse controls should bound request velocity, concurrent work and credential issuance, not reject a room solely because it has many legitimate participants.
- Keep `MoqTransportAdapter` as the only draft-specific boundary.
- Do not claim relay-side enforcement until a browser-to-relay trace proves the deployed credential and namespace controls.
- Do not retain audio or transcript content while adding security telemetry.

---

## SEC-01 — Room creation and joining disclose a relay-wide publish/subscribe bearer

- **Rule:** `access-control.relay-wide-browser-bearer`
- **Taxonomy:** CWE-522
- **Severity / confidence:** High / Medium
- **Status:** Open; relay acceptance and external ACL behaviour remain unverified.

### Evidence

`src/worker/index.ts:98-114` returns the relay credential to an unauthenticated room creator:

```ts
98  if (request.method === "POST" && url.pathname === "/api/rooms") {
99    const body = await readJsonObject(request);
100   const displayName = requiredString(body, "displayName", 80);
101   await enforceCreationRateLimit(request, env);
102   const code = roomCode();
103   const stub = roomStub(env, code);
104   await stub.initialise(code, Date.now());
105   const joined = await stub.join(displayName);
107   return json<CreateRoomResponse>(
108     {
109       ...joined,
110       relayCredential: relayCredential(env),
111       correlationId,
112     },
113     201,
114   );
```

`src/worker/index.ts:289-304` documents that the same provisioned credential grants relay publication and subscription authority:

```ts
296  * This token grants publish and subscribe access at the relay, so routing stays
297  * labelled cooperative. The current Cloudflare token API cannot mint the
298  * room- and track-scoped credentials the long-term design calls for.
299  */
300 function relayCredential(env: Env): string | null {
301   const endpoint = configValue(env.MOQ_RELAY_URL);
302   if (!endpoint) return null;
303   return configuredRelayCredential(env.MOQ_RELAY_TOKEN);
304 }
```

**Reviewer comment:** A Worker secret is being used as an end-user bearer. The browser receives authority that is not bound to its room, participant, publication track, subscription permissions or room expiry. Cooperative UI controls are not an adversarial security boundary.

### Impact

A room creator or joiner can place the bearer in a modified MOQT client and request relay operations outside the application's routing decisions. Same-room routing bypass is source-supported; cross-room access, track collision and spoofing depend on the deployed relay's unverified namespace and token semantics.

### Fix option A — Relay-enforced scoped credentials (recommended)

Add a server-side credential issuer that mints a short-lived grant containing the opaque room ID, participant ID, permitted publication namespace, permitted subscription namespaces and expiry no later than room expiry. The relay must validate those claims and enforce revocation after routing, leave and room termination changes.

Trade-off: this is the cleanest long-term model, but depends on a relay/token API capable of enforcing the claims. Keep `MOQT_TRANSPORT_VERIFIED=false` until a trace proves denial outside the grant.

### Fix option B — Isolate the existing relay credential per room

If claim-based grants are unavailable, provision a distinct relay credential and isolated namespace per room, retain it only for the 20-minute room lifetime, and revoke it when the room ends. Participant publication ownership and per-human subscription consent still need an enforcing relay-side mechanism inside that room.

Trade-off: this narrows cross-room blast radius but creates credential lifecycle and relay-provisioning overhead. It is an interim containment measure, not equivalent to participant-level least privilege.

### Verification required

- Create and join responses receive different, short-lived participant credentials rather than the Worker-wide secret.
- A participant can publish only its own track.
- A subscription disallowed by server-owned routing state is rejected by the relay.
- Leave, routing revocation and room expiry invalidate the relevant grant.
- A real browser-to-relay trace proves those denials over MOQT/WebTransport.

---

## SEC-02 — Any joined human can execute presenter and AI lifecycle controls

- **Rule:** `authorization.any-human-global-room-control`
- **Taxonomy:** CWE-862
- **Severity / confidence:** High / High
- **Status:** Open.

### Evidence

`src/worker/room.ts:187-219` uses ordinary human membership as the only AI-creation authority:

```ts
187 async addAi(
188   credential: ParticipantCredential,
189   displayName: string,
190   options: { address?: string; wakeName?: string; simulated?: boolean } = {},
191 ): Promise<RoomSnapshot> {
192   await this.assertHuman(credential);
193   return this.addAiInternal(displayName, options);
194 }
```

`src/worker/room.ts:785-790` shows why every joined human passes the guard:

```ts
785 private async assertHuman(credential: ParticipantCredential): Promise<ParticipantRow> {
786   const row = await this.assertParticipant(credential.participantId, credential.rejoinToken);
787   if (row.role !== "human") {
788     throw roomError(403, "human_only", "Only a human participant can perform this action.");
789   }
790   return row;
}
```

The same guard protects AI removal, pipeline state, floor operations, AI-to-AI administration and presenter simulation.

**Reviewer comment:** The server has authentication but no presenter or lifecycle authorisation. The `sessionStorage` presenter flag only changes which controls are rendered and can be changed or bypassed by any browser client.

### Impact

An ordinary attendee can add or remove AIs, fabricate their pipeline state, reshape the simulated cast, manipulate AI-to-AI safety counters and interrupt the primary ten-minute stage demonstration for every participant.

### Fix option A — Persisted owner and presenter roles (recommended)

Persist the room creator as `owner`, allow deliberate promotion to `presenter`, and replace `assertHuman` with operation-specific checks such as `assertPresenter` and `assertAiWorker`. Store role changes in the room Durable Object and include an auditable reason for delegation and revocation.

Trade-off: simple to understand and operate, but role checks must be maintained whenever new global methods are introduced.

### Fix option B — Purpose-specific capabilities

Issue separate high-entropy capabilities for presenter administration and each AI worker. Bind presenter capabilities to one room and bind worker capabilities to one AI ID and a narrow operation set. Store only hashes and rotate capabilities when ownership changes.

Trade-off: gives stronger least privilege and avoids a broad role, but introduces more credential issuance, storage and recovery paths.

### Verification required

- A second valid human receives `403` for every presenter and AI lifecycle operation.
- A valid presenter can perform only presenter operations and can be revoked.
- A per-AI worker credential can update only its own pipeline state.
- Presenter simulation remains labelled and ordinary participant routing continues to enforce row ownership.
- AI creation has a separate mutation/cost budget without imposing a participant-count cap.

---

## SEC-03 — Unvalidated AI identifiers can wedge or pre-empt the global floor

- **Rule:** `input-validation.ai-floor-target`
- **Taxonomy:** CWE-20
- **Severity / confidence:** Medium / High
- **Status:** Open.

### Evidence

`src/worker/room.ts:336-360` writes the caller's `aiId` directly into shared floor state:

```ts
336 async requestFloor(
337   credential: ParticipantCredential,
338   aiId: string,
339 ): Promise<{ granted: boolean; room: RoomSnapshot }> {
340   await this.assertHuman(credential);
341   this.assertActive();
342   const now = Date.now();
343   const meta = this.meta();
344   if (!meta) throw roomError(404, "room_not_found", "Room is not initialised.");

346   if (meta.floor_holder === aiId) return { granted: true, room: this.snapshot() };
347   if (meta.floor_holder === null) {
348     this.ctx.storage.sql.exec(
349       "UPDATE room_meta SET floor_holder = ?, floor_since = ? WHERE singleton = 1",
350       aiId,
351       now,
352     );
353   }
358   this.ctx.storage.sql.exec(
359     "INSERT INTO floor_queue (ai_id, queued_at) VALUES (?, ?) ON CONFLICT(ai_id) DO NOTHING",
360     aiId,
```

**Reviewer comment:** No lookup proves that the target exists, is an AI, is connected or is controlled by the caller. The queue schema also has no referential relationship to active AI participants.

### Impact

A joined human can install a nonexistent or human participant as the floor holder, queue arbitrary identifiers or release another AI's active turn. Legitimate AIs can remain blocked until the bogus identifier is explicitly released or the room expires.

### Fix option A — Application-level target and turn validation (recommended)

Before every request or release, resolve `aiId` to an active `role = 'ai'` participant. On grant, mint a short-lived turn ID bound to the AI and require that turn ID for release. Reject nonexistent, left, human and stale targets.

Trade-off: explicit and easy to test, but every lifecycle path must continue cleaning stale floor state.

### Fix option B — Relational floor lease model

Replace the free-text holder and queue with a floor-lease table whose AI identifiers reference participant rows and whose rows include lease IDs and expiry. Execute lifecycle and floor transitions transactionally so a removed AI cannot remain a holder or queued entry.

Trade-off: gives stronger storage invariants, but requires a SQLite schema migration and careful rollback planning.

### Verification required

- Reject nonexistent, human and left target IDs.
- Reject release without the current AI's valid turn/lease ID.
- Removing an AI transactionally clears its holder and queue state.
- Concurrent requests preserve deterministic ordering and never leave an unreachable holder.

---

## SEC-04 — Public room snapshots disclose every human's per-AI routing preferences

- **Rule:** `privacy.routing-preference-disclosure`
- **Taxonomy:** CWE-200
- **Severity / confidence:** Medium / High
- **Status:** Open.

### Evidence

`src/worker/room.ts:820-837` builds one viewer-independent snapshot containing every routing row:

```ts
820 private snapshot(): RoomSnapshot {
821   const meta = this.assertActive();
822   const participants = this.ctx.storage.sql
823     .exec<ParticipantRow>("SELECT * FROM participants WHERE state != 'left' ORDER BY joined_at")
824     .toArray()
825     .map(toParticipant);
826   const routing = this.ctx.storage.sql
827     .exec<RoutingRow>("SELECT * FROM routing ORDER BY updated_at")
828     .toArray()
829     .map((row) => toRouting(row, this.routingEnforcement()));

831   return {
832     code: meta.code,
835     participants,
836     routing,
```

**Reviewer comment:** Because `snapshot()` has no viewer identity, it cannot enforce the specification's owner-only routing-row rule. The public HTTP endpoint, join responses and WebSocket snapshots all reuse this representation.

### Impact

Anyone with the room code can correlate display names and participant IDs with individual `Hears me` and `I hear it` choices. The room code limits discoverability but does not justify disclosing each participant's consent and listening preferences to all invitees.

### Fix option A — Viewer-specific snapshot projection (recommended)

Pass authenticated viewer context into snapshot construction. Return detailed routing rows only where `human_id` matches the viewer and compute a separate aggregate `partialContext` value for other participants. Keep the unauthenticated snapshot limited to public membership and coarse room state.

Trade-off: keeps the existing API shape but requires every snapshot caller and broadcast path to supply the correct viewer.

### Fix option B — Separate public and private state channels

Define `PublicRoomSnapshot` without detailed routing rows and a participant-authenticated routing endpoint or private WebSocket event stream for the viewer's rows. Publish only aggregate routing changes on the shared room channel.

Trade-off: clearer privacy ownership and types, but introduces additional client reconciliation and endpoint/event handling.

### Verification required

- An unauthenticated room-code request cannot obtain detailed routing rows.
- Human A cannot retrieve Human B's routing choices through HTTP, join or WebSocket payloads.
- Each human still receives their own complete row and can update it.
- The UI can render `Partial context` without revealing who withheld consent.

---

## SEC-05 — A reusable participant bearer is placed in the WebSocket query string

- **Rule:** `credential-exposure.websocket-query-bearer`
- **Taxonomy:** CWE-598
- **Severity / confidence:** Medium / Medium
- **Status:** Open; external full-URL logging is not verified.

### Evidence

`src/client/api.ts:187-198` explicitly treats the URL as secret while placing the reusable token in it:

```ts
187 /**
188  * §8 link separation: the control-plane socket carries the participant token in
189  * a query string, so this URL is a secret and never appears in telemetry or a
190  * share link.
191  */
192 export function roomEventsUrl(session: StoredSession): string {
193   const url = new URL(`/api/rooms/${session.code}/events`, location.href);
194   url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
195   url.searchParams.set("participant", session.participantId);
196   url.searchParams.set("token", session.rejoinToken);
197   return url.toString();
198 }
```

**Reviewer comment:** The query value is not a narrow WebSocket ticket. It is the same bearer used for participant mutations and reclaim, and it is returned unchanged rather than consumed or rotated.

### Impact

If Cloudflare, a proxy, browser diagnostic, support bundle or future observability integration records the complete handshake URL, a reader can replay the participant credential during the active room or reconnect window.

### Fix option A — Single-use WebSocket ticket (recommended)

Add an authenticated HTTP endpoint that exchanges the participant credential for a random, purpose-bound socket ticket with a very short expiry. Store its hash and consume it atomically on the first successful upgrade. Rotate the participant rejoin credential after successful reclaim.

Trade-off: adds one request before connecting, but gives explicit purpose, replay and expiry controls.

### Fix option B — Short-lived, HttpOnly socket cookie

Set a dedicated `Secure`, `HttpOnly`, `SameSite=Strict` cookie scoped to the room's socket path after authenticated exchange, then clear it after upgrade or expiry. Do not put the general participant token in the cookie.

Trade-off: keeps secrets out of URLs and JavaScript, but cookie path/scope, concurrent rooms and browser retry behaviour require careful handling.

### Verification required

- The WebSocket URL contains no participant or rejoin bearer.
- Reusing a consumed or expired ticket returns `401`.
- Tickets cannot be used for HTTP mutations or another room/participant.
- Reclaim invalidates the previous rejoin token.
- Application and platform logs remain query- and credential-free.

---

## SEC-06 — One participant token can open unbounded concurrent control sockets

- **Rule:** `resource-exhaustion.concurrent-control-sockets`
- **Taxonomy:** CWE-770
- **Severity / confidence:** Medium / High
- **Status:** Open.

### Evidence

`src/worker/room.ts:466-496` tags the socket but never checks existing sockets for that participant:

```ts
466 async fetch(request: Request): Promise<Response> {
470   const url = new URL(request.url);
471   const participantId = url.searchParams.get("participant") ?? "";
472   const rejoinToken = url.searchParams.get("token") ?? "";
477   await this.assertParticipant(participantId, rejoinToken);

484   const pair = new WebSocketPair();
485   const client = pair[0];
486   const server = pair[1];
487   server.serializeAttachment({ participantId } satisfies SocketAttachment);
488   this.ctx.acceptWebSocket(server, [`participant:${participantId}`]);
489   server.send(
490     JSON.stringify({
491       type: "snapshot",
492       room: this.snapshot(),
493       at: Date.now(),
494     } satisfies RoomEvent),
495   );
496   return new Response(null, { status: 101, webSocket: client });
```

**Reviewer comment:** Every credential replay allocates a socket and serialises a full snapshot. Every later broadcast iterates all accepted sockets, multiplying work controlled by one participant.

### Impact

A malicious participant or stolen-token holder can consume Durable Object connection capacity and amplify snapshot and broadcast work until legitimate control-plane clients are delayed or disconnected.

### Fix option A — One active socket per participant (recommended)

Use the existing participant tag to find and close the previous socket immediately before accepting its replacement. Combine this with the single-use ticket in SEC-05 so a successful reconnect transfers ownership deterministically.

Trade-off: simplest bound and a good fit for one browser tab per participant, but intentional multi-device or overlapping handoff would need explicit product support.

### Fix option B — Small concurrency and upgrade-rate budget

Permit a documented small number of sockets per participant, enforce a token bucket for upgrades, and reject excess with `429` plus `Retry-After`. Bound initial snapshot size/work and remove failed sockets from broadcasts.

Trade-off: accommodates handoff and transient overlap, but has more state and still allows bounded amplification.

### Verification required

- Opening a second socket either replaces the first or receives the documented refusal.
- Burst upgrades exhaust only the caller's budget.
- Broadcasts target only authorised, usable sockets.
- Reconnect continues to reclaim identity without duplicate playback.

---

## SEC-07 — Unthrottled open-room joins permit unbounded participant and routing allocation

- **Rule:** `resource-exhaustion.unthrottled-open-joins`
- **Taxonomy:** CWE-770
- **Severity / confidence:** Medium / High
- **Status:** Open.

### Evidence

`src/worker/room.ts:148-180` allocates persistent state for every fresh join:

```ts
148 async join(displayName: string, rejoinToken?: string): Promise<RoomJoinResult> {
149   this.assertActive();
150   const now = Date.now();
152   if (rejoinToken) {
153     const reclaimed = await this.reclaim(displayName, rejoinToken, now);
154     if (reclaimed) return reclaimed;
155   }

157   const participantId = crypto.randomUUID();
158   const token = randomToken();
159   this.ctx.storage.sql.exec(
160     `INSERT INTO participants (...)
163      VALUES (?, ?, 'human', 'connected', ?, NULL, ?, 0, NULL, NULL, NULL, ?)`,
164     participantId,
165     displayName,
166     now,
167     await sha256(token),
168     now,
169   );
172   this.seedRoutingForHuman(participantId, now);
175   this.broadcast({ type: "participant_changed", participantId, state: "connected", at: now });
176   return {
177     room: this.snapshot(),
178     participant: this.participant(participantId),
179     rejoinToken: token,
180   };
```

**Reviewer comment:** Open membership is a product requirement, but unlimited participant count does not require unlimited join velocity from one source or room-code holder. Each request also expands human-by-AI routing work and snapshot size.

### Impact

A room-code holder can rapidly create participant identities, routing rows, broadcasts, snapshots and relay-credential responses, degrading the room Durable Object for legitimate participants.

### Fix option A — Per-source and per-room token buckets (recommended)

Apply independent join buckets keyed by privacy-preserving source hash and room code, with a generous burst for stage entry and `Retry-After` on exhaustion. Apply a separate credential-minting budget. Do not inspect or reject based on total participant count.

Trade-off: operationally straightforward, but NAT-shared audiences need a sufficiently generous source bucket and room-level capacity planning.

### Fix option B — Bound per-join work and queue admission

Serialise joins through a room work queue with a fixed per-interval budget, lazily materialise routing defaults instead of inserting the full cross-product immediately, and return incremental/delta state rather than serialising the complete snapshot twice.

Trade-off: preserves open admission under large legitimate bursts and reduces amplification, but requires a more substantial room-state and client-reconciliation change.

### Verification required

- Rapid joins from one source or room receive bounded `429` responses with `Retry-After`.
- Legitimate joins resume after token refill.
- The service never rejects solely because the room already has many participants.
- Routing-row, snapshot and broadcast work remains bounded during a burst.
- Relay credential issuance is limited independently from room creation.

---

## SEC-08 — Worker parses unbounded JSON bodies before rate limiting or authentication

- **Rule:** `resource-exhaustion.unbounded-json-body`
- **Taxonomy:** CWE-400
- **Severity / confidence:** Medium / High
- **Status:** Open.

### Evidence

`src/worker/validation.ts:11-25` calls `request.json()` before enforcing an application byte limit:

```ts
11 export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
12   const contentType = request.headers.get("content-type") ?? "";
13   if (!contentType.toLowerCase().includes("application/json")) {
14     throw new HttpError(415, "unsupported_media_type", "Expected an application/json request.");
15   }

17   try {
18     const value: unknown = await request.json();
19     if (!value || typeof value !== "object" || Array.isArray(value)) {
20       throw new Error("body is not an object");
21     }
22     return value as Record<string, unknown>;
23   } catch (error) {
24     if (error instanceof HttpError) throw error;
25     throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
```

**Reviewer comment:** Field-size checks, the room-creation limiter and Durable Object authentication happen only after the complete attacker-controlled body has been allocated and parsed.

### Impact

Unauthenticated or invalid-credential callers can repeatedly force Worker isolates to parse bodies far larger than legitimate requests, consuming CPU and memory before eventual rejection.

### Fix option A — Central bounded streaming JSON reader (recommended)

Replace `request.json()` with a helper that rejects declared `Content-Length` above a small limit such as 8 KiB, reads the stream while counting bytes, cancels when the limit is exceeded, then parses the bounded buffer. Return `413 Payload Too Large` with a stable error code.

Trade-off: one reusable implementation protects every route, but the stream reader needs focused malformed, chunked and Unicode tests.

### Fix option B — Early gateway enforcement plus route reordering

Configure a Cloudflare request-body rule for the JSON API paths and move creation throttling and header-carried participant authentication ahead of body consumption. Retain an application-level declared-length check as defence in depth.

Trade-off: rejects attacks earlier at the edge, but creates production configuration ownership and must not become the only control because local and alternate environments still need protection.

### Verification required

- Declared and chunked bodies above the limit receive `413` before JSON parsing.
- Malformed bodies inside the limit still receive the existing useful `400` response.
- Room-creation throttling runs before body consumption.
- Authentication can reject invalid mutation callers before parsing where credentials are available in headers.

---

## SEC-09 — Playback deduplication retains unbounded object identifiers per group

- **Rule:** `resource-exhaustion.unbounded-playback-dedupe`
- **Taxonomy:** CWE-770
- **Severity / confidence:** Medium / High
- **Status:** Open.

### Evidence

`src/client/audio/PlaybackDeduplicator.ts:21-37` caps group count but not object identifiers within a group:

```ts
21 accept(participantId: string, groupId: number, objectId: number): boolean {
22   let groups = this.seen.get(participantId);
23   if (!groups) {
24     groups = new Map<number, Set<number>>();
25     this.seen.set(participantId, groups);
26   }

28   let objects = groups.get(groupId);
29   if (!objects) {
30     objects = new Set<number>();
31     groups.set(groupId, objects);
32     this.prune(groups);
33   }

35   if (objects.has(objectId)) return false;
36   objects.add(objectId);
37   return true;
```

`src/client/audio/TrackPlayer.ts:72-87` records the ID before validating the payload:

```ts
73 accept(groupId: number, objectId: number, payload: Uint8Array, now: number): void {
76   if (!this.dedupe.accept(this.participantId, groupId, objectId)) return;

78   let decoded: { metadata: AudioFrameMetadata; opusFrame: Uint8Array };
79   try {
80     decoded = decodeAudioObject(payload);
81   } catch (error) {
82     this.callbacks.onError?.(
83       this.trackId,
84       error instanceof Error ? error : new Error("Malformed audio object."),
85     );
86     return;
87   }
```

**Reviewer comment:** A publisher can hold one group ID constant and vary object IDs forever. Even malformed objects consume retained state because deduplication happens before envelope validation.

### Impact

Every automatically subscribed listener can accumulate attacker-controlled identifiers until the browser becomes unresponsive or terminates the tab.

### Fix option A — Validate first and cap each Set (recommended)

Decode and validate the envelope and identifier progression before calling the deduplicator. Cap objects per group using the expected 50 objects per second plus a documented burst allowance, cap total entries per track and quarantine a publisher after repeated excess or malformed objects.

Trade-off: minimal change to the current structure, but the chosen limits and group-transition rules must be explicit and tested.

### Fix option B — Sliding bitmap or sequence window

Replace the nested `Set` with a fixed-size sliding bitmap/window keyed to monotonic group and object progression. Accept only identifiers inside the current replay window and advance the window as groups progress.

Trade-off: gives a hard memory bound and efficient duplicate checks, but requires careful wrap, restart and 60-second rejoin semantics.

### Verification required

- Thousands of unique IDs in one group cannot grow retained state beyond the configured bound.
- Malformed objects do not consume deduplication state.
- Normal 20 ms cadence, late recovery and reload deduplication still work.
- Repeated over-budget objects visibly quarantine or unsubscribe the offending track.

---

## SEC-10 — Media bursts trigger count-unbounded sorting and decoder submission

- **Rule:** `resource-exhaustion.media-burst-sorting`
- **Taxonomy:** CWE-407
- **Severity / confidence:** Medium / High
- **Status:** Open.

### Evidence

`src/client/audio/AdaptiveJitterBuffer.ts:41-66` scans and sorts a count-unbounded array on every insertion:

```ts
41 push(frame: BufferedFrame<T>): void {
44   if (this.cancelledGroups.has(frame.groupId)) {
45     this.cancelledDrops += 1;
46     return;
47   }
48   if (this.frames.some((candidate) => candidate.sequence === frame.sequence)) return;

57   this.lastArrivalAt = frame.receivedAt;
59   this.frames.push(frame);
60   this.frames.sort((left, right) => left.sequence - right.sequence);

62   const staleBefore = frame.receivedAt - this.maximumMs;
63   const retained = this.frames.filter((candidate) => candidate.receivedAt >= staleBefore);
65   this.lateDrops += this.frames.length - retained.length;
66   this.frames = retained;
```

`src/client/audio/TrackPlayer.ts:128-136` drains every eligible frame without a work or decoder-queue budget:

```ts
129 drain(now: number): void {
130   for (;;) {
131     const next = this.buffer.pull(now);
132     if (!next) break;
133     this.concealGapBefore(next.metadata.sequence);
134     this.lastPlayedSequence = next.metadata.sequence;
135     this.decodeFrame(next.metadata, next.frame);
136   }
```

**Reviewer comment:** The 200 ms stale window is a latency bound, not a frame-count or byte bound. A burst with near-identical receipt times survives pruning while repeatedly causing linear scans and full sorts, then floods `AudioDecoder`.

### Impact

A malicious publisher can impose superlinear main-thread work, retain many copied frames and overload the browser decoder queue, causing audible failure, UI stalls or tab termination.

### Fix option A — Bounded ordered receive structure (recommended)

Replace repeated array sorting with a fixed-capacity sequence-indexed ring or bounded heap. Track both frame count and encoded bytes, reject implausible cadence or sequence progression, and expose excess drops in the inspector.

Trade-off: strongest structural fix, but changes core jitter-buffer behaviour and needs deterministic ordering, cancellation and recovery tests.

### Fix option B — Admission and decode budgets around the current buffer

Keep the existing array temporarily but reject frames before insertion when per-track count, bytes or token-bucket cadence exceed limits. Cap work per `drain()` call, check `AudioDecoder.decodeQueueSize`, and drop stale excess work instead of submitting it.

Trade-off: smaller patch and good immediate containment, but bounded array sorting may still be less efficient than a purpose-built structure.

### Verification required

- Adversarial bursts cannot exceed fixed frame and byte limits.
- Excess objects are dropped before scan/sort work.
- `drain()` yields after its time/frame budget and respects decoder queue depth.
- CPU, heap and audible recovery are measured under a malicious burst and normal packet reordering.

---

## SEC-11 — Unknown room-code probes initialise persistent SQLite Durable Objects

- **Rule:** `resource-exhaustion.unknown-room-durable-object`
- **Taxonomy:** CWE-770
- **Severity / confidence:** Medium / High
- **Status:** Open; exact Cloudflare billing and quota effects remain unverified.

### Evidence

`src/worker/room.ts:106-112` runs migration whenever an attacker-selected Durable Object name is constructed:

```ts
106 export class Room extends DurableObject<Env> {
107   constructor(ctx: DurableObjectState, env: Env) {
108     super(ctx, env);
109     ctx.blockConcurrencyWhile(async () => {
110       this.migrate();
111     });
112   }
```

`src/worker/room.ts:535-593` writes schema state even when the room was never initialised:

```ts
535 private migrate(): void {
536   const sql = this.ctx.storage.sql;
537   sql.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)");
538   const current =
539     sql.exec<{ version: number }>("SELECT version FROM schema_meta LIMIT 1").toArray()[0]
540       ?.version ?? 0;
541   if (current === SCHEMA_VERSION) return;
// ... creates room_meta, participants, routing, floor_queue and rate_events ...
592   sql.exec("DELETE FROM schema_meta");
593   sql.exec("INSERT INTO schema_meta (version) VALUES (?)", SCHEMA_VERSION);
```

**Reviewer comment:** A syntactically valid random room code is mapped to `getByName` before existence is known. The resulting object writes SQLite state but has no `room_meta` expiry or alarm cleanup path.

### Impact

An unauthenticated caller can generate many valid-looking room codes and create persistent empty object state outside the six-per-ten-minute room-creation limiter.

### Fix option A — Statelessly verifiable room codes (recommended)

Make the externally shared join code a random identifier plus an authenticated signature/MAC that the Worker can validate before `getByName`. Only codes minted by the rate-limited creation path can resolve a Room object.

Trade-off: avoids a central lookup and rejects probes cheaply, but requires key management and a versioned code format while keeping links non-guessable.

### Fix option B — Rate-limited room registry

Maintain a compact registry of valid active room codes in a dedicated Durable Object or appropriate Cloudflare store. Check it before resolving a room object, expire entries with the room and rate-limit unknown-code probes.

Trade-off: straightforward and revocable, but adds a shared coordination component and its own availability and consistency requirements.

### Verification required

- Probing an unknown valid-looking code performs no room-object SQLite write.
- Large numbers of unique unknown codes are rejected before `getByName`.
- Valid room creation, join and 60-second reclaim still work.
- Registry/signature expiry aligns with the 20-minute room hard stop.

---

## SEC-12 — Narrow read-only clients still start microphone capture and publication

- **Rule:** `privacy.narrow-read-only-microphone`
- **Taxonomy:** CWE-359
- **Severity / confidence:** Medium / Medium
- **Status:** Open; live narrow-browser publication has not been exercised.

### Evidence

`src/client/session/RoomSession.ts:241-262` starts publication for every room session, regardless of the read-only UI:

```ts
241 /**
242  * Applies a room snapshot the caller already fetched, starts microphone
243  * capture, then opens the control channel and evaluates transport.
244  */
247 async start(room: RoomSnapshot): Promise<void> {
248   this.startedAt = this.now();
249   this.applyRoom(room);
250   this.openControlChannel();
254   void this.devices.start();
258   void this.runNetworkProbe(room);
259   // The room entry action expresses the user's intent to join live audio.
260   // Browser permission remains authoritative; denial becomes listen-only.
261   void this.startPublishing();
262   await this.openTransport();
}
```

`src/client/audio/CaptureController.ts:59-72` reaches the privacy-sensitive API:

```ts
59 const support = inspectCaptureSupport();
60 if (!support.available) throw new Error(support.reason);

63 this.stream = await navigator.mediaDevices.getUserMedia({
64   audio: {
65     channelCount: 1,
66     sampleRate: CAPTURE_SAMPLE_RATE,
67     echoCancellation: true,
68     noiseSuppression: true,
69     autoGainControl: true,
70   },
71   video: false,
72 });
```

**Reviewer comment:** The narrow-screen restriction is implemented through labels and CSS-hidden controls, not as a capability consumed by session, capture and publication code. Previously granted browser permission can therefore permit capture despite the read-only promise.

### Impact

A narrow-screen user can be told that the room is read-only while microphone capture starts after joining. If the relay accepts publication, their audio can be transmitted contrary to the stated mobile boundary.

### Fix option A — Explicit session capability policy (recommended)

Determine `{ canCapture, canPublish, canControl }` before constructing or starting `RoomSession`. In read-only mode, never call `startPublishing()` or `getUserMedia`, never create a publication, and stop active capture if the capability changes. Require a fresh explicit opt-in before enabling capture.

Trade-off: keeps one session implementation and makes capability state testable, but every capture/publication entry point must honour the policy.

### Fix option B — Separate read-only session composition

Create a `ReadOnlyRoomSession` or read-only hook that owns membership, control events, subscriptions and inspector state but does not construct capture, encoder or publication components. Route narrow/unsupported clients to it before room startup.

Trade-off: structurally prevents accidental publishing, but duplicates some orchestration unless shared receive/control behaviour is factored carefully.

### Verification required

- On every narrow/unsupported configuration, `getUserMedia` is never called.
- No publication is created and no uplink/publish event appears.
- Receiving audio, membership and the inspector remain functional.
- Transitioning to read-only closes existing capture and publication.
- Enabling publication requires an explicit user action and a verified supported configuration.

---

## SEC-13 — Any participant can spoof another participant's activity

- **Rule:** `authorization.activity-target-spoofing`
- **Taxonomy:** CWE-639
- **Severity / confidence:** Low / High
- **Status:** Open.

### Evidence

`src/worker/room.ts:455-464` authenticates the caller but updates an unrelated caller-selected target:

```ts
455 /** Audio object arrival is the source of truth for "connected" (§6.2). */
456 async markActive(credential: ParticipantCredential, participantId: string): Promise<void> {
457   await this.assertParticipant(credential.participantId, credential.rejoinToken);
458   if (!this.meta()) return;
459   this.ctx.storage.sql.exec(
460     "UPDATE participants SET last_active_at = ? WHERE id = ?",
461     Date.now(),
462     participantId,
463   );
464 }
```

**Reviewer comment:** Authentication proves who submitted the request, not that the target published audio or that the caller observed an authorised track. Participant IDs are available in room snapshots.

### Impact

An attendee can make another participant appear recently active and influence shared participant ordering or prominence. The impact is presentation integrity rather than media routing or confidentiality.

### Fix option A — Keep activity local to each listener (recommended for v1)

Remove the shared arbitrary-target mutation and derive speaking/recency presentation from each listener's own `TrackPlayer` object-arrival state. Do not persist or broadcast activity that the server cannot verify.

Trade-off: different listeners may briefly show different activity based on network arrival, but this is truthful and avoids a new trust protocol.

### Fix option B — Trusted publication-derived activity

When the deployed relay or a trusted media orchestration boundary can emit authenticated publication events, update `last_active_at` only from that source. Bind the event to the participant track and rate-limit updates.

Trade-off: produces shared authoritative recency, but depends on a trusted transport integration that does not yet exist and must not be simulated by ordinary clients.

### Verification required

- One participant cannot update another participant's shared recency through the public API.
- Activity reflects locally observed or trusted publication events only.
- Repeated activity reports are bounded and contain no audio or device data.
- Participant layout remains deterministic when activity is unavailable.

---

## Recommended implementation order

1. Fix SEC-02 first so ordinary attendees cannot mutate presenter, AI and floor administration while other controls are being added.
2. Implement SEC-05 and SEC-06 together because single-use socket tickets provide the clean ownership primitive for bounded control sockets.
3. Implement SEC-08 and SEC-07 as Worker/Durable Object admission controls without weakening open membership.
4. Implement SEC-09 and SEC-10 together around one explicit per-track receive budget and adversarial media test harness.
5. Fix SEC-04 and SEC-12 before any broader audience trial because they concern user privacy expectations.
6. Fix SEC-03, SEC-11 and SEC-13 as contained room-integrity and resource-hardening changes.
7. Treat SEC-01 as the live-transport security gate: design independent work can proceed, but relay enforcement must be implemented and trace-verified before transport is claimed as working.

## Closure checklist

An issue is closed only when:

- the chosen fix and rejected alternative are recorded;
- the source change and tests are linked;
- negative/adversarial tests pass;
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm deploy:dry-run` pass where the boundary is affected;
- browser verification runs where client capture, media or WebSocket behaviour changed;
- no secret, display name, device label, transcript or audio content is added to logs or telemetry;
- any live relay claim is backed by a reproducible browser-to-relay trace; and
- a focused security re-review confirms the source-to-sink path is actually broken.
