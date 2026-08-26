# Security Review: real-fabric

## Scope

Standard whole-repository security scan of the exact registered Git revision.

- Scan mode: repository
- Target kind: git_revision
- Target ID: target_sha256_690c8d74bb6e1a171cb72821754974babed6c67f0b0839e1155698cb2e34090d
- Revision: a784122aa18c6b7fbee1ae53d34b054a24d71f0b
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none
- Runtime or test status: Complete offline source review of all 93 authorised files at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; 13 distinct findings validated.
- Artifacts reviewed: .claude/launch.json, .dev.vars.example, .gitignore, AGENTS.md, MEMORIES.md, PRODUCT_SPEC_v1-demo_1.md, README.md, Standards.md, biome.json, design/PRODUCT_SPEC_v1-demo.md, design/concepts/entry.png, design/concepts/mobile.png, design/concepts/room.png, index.html, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, public/audio/capture-worklet.js, public/audio/mixer-worklet.js, scripts/workers-build.mjs, src/client/App.tsx, src/client/ai/AiDirector.ts, src/client/ai/ScriptedResponder.ts, src/client/api.ts, src/client/audio/AdaptiveJitterBuffer.ts, src/client/audio/CaptureController.ts, src/client/audio/DegradationLadder.ts, src/client/audio/DeviceWatcher.ts, src/client/audio/DriftEstimator.ts, src/client/audio/MixerGraph.ts, src/client/audio/PacketLossConcealer.ts, src/client/audio/PlaybackDeduplicator.ts, src/client/audio/TrackPlayer.ts, src/client/audio/UniversalAudioCaptureAdapter.ts, src/client/audio/VoiceActivityDetector.ts, src/client/audio/frame.ts, src/client/components/Brand.tsx, src/client/components/DemoScriptPanel.tsx, src/client/components/FailureBanner.tsx, src/client/components/Inspector.tsx, src/client/components/MeasurementValue.tsx, src/client/components/ParticipantCard.tsx, src/client/components/PinnedConfigBanner.tsx, src/client/components/PreflightPanel.tsx, src/client/components/PresenterStrip.tsx, src/client/components/SignalPath.tsx, src/client/components/StatusLight.tsx, src/client/components/SubscriptionGraph.tsx, src/client/hooks/useCapabilities.ts, src/client/hooks/useRoomSession.ts, src/client/main.tsx, src/client/pages/EntryPage.tsx, src/client/pages/PreflightPage.tsx, src/client/pages/RoomPage.tsx, src/client/presenter/DemoScript.ts, src/client/room/participantLayout.ts, src/client/session/ReconnectionPolicy.ts, src/client/session/RoomSession.ts, src/client/session/SessionEventLog.ts, src/client/styles.css, src/client/telemetry/SessionTelemetry.ts, src/client/transport/MoqTransportAdapter.ts, src/client/transport/NetworkProbe.ts, src/shared/contracts.ts, src/shared/failures.ts, src/shared/latency.ts, src/shared/measurement.ts, src/shared/pinnedConfiguration.ts, src/shared/tracks.ts, src/worker/env.ts, src/worker/index.ts, src/worker/relayCredential.ts, src/worker/room.ts, src/worker/roomError.ts, src/worker/validation.ts, test/audio-frame.test.ts, test/capture-adapter.test.ts, test/invariants.test.ts, test/jitter-buffer.test.ts, test/milestone-1-transport.test.ts, test/milestone-2-audio.test.ts, test/room-service.test.ts, test/validation.test.ts, test/worker.test.ts, tsconfig.app.json, tsconfig.json, tsconfig.node.json, tsconfig.test.json, tsconfig.worker.json, vite.config.ts, vitest.config.ts, worker-configuration.d.ts, wrangler.jsonc
- Scan context: Registered revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b, materialised read-only from Git because the registered checkout advanced after launch.

Limitations and exclusions:
- MOQT relay acceptance, token ACLs, expiry, duplicate-publication behaviour and cross-room enforcement were not exercised.
- Cloudflare intermediary URL logging, request quotas, Durable Object billing and runtime limits were not inspected.
- Narrow-screen capture/publication and browser media-exhaustion thresholds were not reproduced in a live browser.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 13 |
| Severity mix | high: 2, medium: 10, low: 1 |
| Confidence mix | high: 10, medium: 3 |
| Coverage | complete |
| Validation mode | Offline source trace with independent baseline, focused control/media investigations and full inventory reconciliation. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Real Fabric is a ten-minute conference-stage demo in which a React/Vite browser creates or joins an open room through a Cloudflare Worker, receives a participant rejoin credential and a provisioned relay credential, opens an authenticated control-plane WebSocket to a per-room SQLite Durable Object, and publishes or subscribes to independent audio tracks through MoqTransportAdapter and a Cloudflare WebTransport/MOQT relay. There is no live AI pipeline; AI behaviour is labelled presenter simulation. Production and declared staging select MOQT draft 16, cooperative routing, unknown discovery and an unverified transport claim (wrangler.jsonc:3-30,37-48; src/client/session/RoomSession.ts:241-320; src/worker/index.ts:77-143).

### Assets

- Raw microphone audio, Opus frames and decoded PCM, kept in browser memory/worklets and not persisted by application source (src/client/audio/CaptureController.ts:34-43,62-115,147-170; public/audio/mixer-worklet.js:23-67).
- The provisioned MOQ_RELAY_TOKEN and its coarse relay publish/subscribe authority, returned to every creator or joiner and appended to the WebTransport URL path (src/worker/env.ts:16-25; src/worker/index.ts:98-143,289-304; src/client/transport/MoqTransportAdapter.ts:225-271,532-540).
- Participant identity and control authority: room code, participant ID, rejoin token/hash, role, state and routing ownership (src/client/api.ts:10-17,200-230; src/worker/room.ts:45-68,148-180).
- Room-state integrity for membership, routing, AI pipeline/floor, simulation, AI-to-AI turns, expiry and reconnect deadlines (src/worker/room.ts:70-84,535-594,820-855).
- Privacy of display names and routing relationships in a complete RoomSnapshot readable by a room-code holder (src/shared/contracts.ts:51-78,126-138; src/worker/index.ts:117-143).
- Relay-visible track namespace integrity: demo/\<room-code\>/\<participant-id\>/audio/\<participant-id\>, not independently bound to a participant by the shared credential (src/shared/tracks.ts:17-40; src/client/session/RoomSession.ts:544-580).
- Availability controls: creation throttling, room expiry, AI turn cap and bounded simulation counts; concurrent-room, credential-issuance and AI-cost ceilings are absent (src/shared/contracts.ts:24-35; src/worker/room.ts:114-138,383-430; PRODUCT_SPEC_v1-demo_1.md:17-31).
- Sanitised telemetry, application logs and privileged Cloudflare build/deployment authority (src/client/telemetry/SessionTelemetry.ts:15-81; src/worker/index.ts:33-73,382-389; package.json:8-18).

### Trust Boundaries

- Unauthenticated Internet caller to Worker API: health and creation are public; joining is open with a room code; full snapshots are readable with the room code; field validation follows whole-body parsing (src/worker/index.ts:77-143; src/worker/validation.ts:11-105).
- Participant browser to Durable Object: mutations carry participantId and rejoinToken; routing binds its row to the authenticated participant, while AI, floor, AI-to-AI and presenter operations require only any human role (src/worker/room.ts:272-452,785-810).
- Participant browser to control WebSocket: the reusable token is placed in a same-origin query string and authenticated before socket acceptance; only ping/pong client messages are accepted (src/client/api.ts:187-198; src/worker/index.ts:263-280; src/worker/room.ts:466-533).
- Worker secret to browser and relay: the same optional secret is returned raw at create/join, held in memory and encoded into the relay URL path (src/worker/relayCredential.ts:1-13; src/worker/index.ts:98-143,289-304; src/client/transport/MoqTransportAdapter.ts:532-597).
- Relay-originated setup and media objects to moqtail, TrackPlayer, jitter/deduplication buffers, decoder and mixer; dependency internals and relay are outside the inventory (src/client/transport/MoqTransportAdapter.ts:1-18,307-471; src/client/audio/TrackPlayer.ts:72-136).
- Developer/CI principal to Cloudflare deployment through pinned Wrangler; account and approval are external (package.json:8-18; wrangler.jsonc:1-16).

### Attacker Capabilities

- An unauthenticated caller can create a limited number of rooms and join any known room code, but lacks another participant token and deployment credentials (src/worker/index.ts:77-143,327-344).
- A room-code holder can read the complete RoomSnapshot without joining (src/worker/index.ts:117-143; src/shared/contracts.ts:126-138).
- A joined human receives a reusable participant credential and the configured shared relay token; their participant credential authorises all AI, floor, AI-to-AI and presenter operations because the backend checks only human role (src/worker/index.ts:155-260; src/worker/room.ts:187-452).
- A shared relay-token holder gains the externally configured coarse authority; source implements no per-room, participant or track grant and labels routing cooperative (src/worker/index.ts:289-304; src/worker/room.ts:916-920).
- A malicious participant publisher or compromised relay can supply setup and media objects to the browser receive path (src/client/transport/MoqTransportAdapter.ts:225-471).

### Security Objectives

- Keep credentials out of share links, snapshots, telemetry and application logs, and issue only short-lived least-privilege relay authority (src/shared/contracts.ts:140-154; src/client/api.ts:187-219; src/client/telemetry/SessionTelemetry.ts:24-81).
- Preserve routing ownership and distinguish ordinary participant authority from presenter/global room authority; never claim relay enforcement while credentials are coarse (src/worker/room.ts:267-452,916-920).
- Bound request, room, WebSocket and media-object resources without imposing a legitimate participant-count cap (src/shared/contracts.ts:24-35; src/worker/room.ts:114-138,499-525).
- Validate identifiers and input; store only token hashes and require matching active participant credentials (src/worker/index.ts:117-123,306-344; src/worker/validation.ts:11-105; src/worker/room.ts:793-810,1035-1045).
- Keep microphone audio transient and close capture, worklets, publications, subscriptions and sockets on leave (src/client/audio/CaptureController.ts:147-170; src/client/session/RoomSession.ts:995-1019).
- Bind privileged deployment to the intended account, Worker, environment, revision and payload externally (package.json:8-18; wrangler.jsonc:1-16).

### Assumptions

- Offline review is limited to the exact 93-file snapshot at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; deployed secrets, relay acceptance and runtime exploitability are unverified.
- No SECURITY.md, supplied threat model, user security context or authoritative knowledge base was available.
- Docs say the relay token is configured and expires on 2026-09-01, but source proves only an optional secret reference (README.md:85-92; src/worker/env.ts:16-25).
- The Product Spec calls the rejoin token single-use, but source reuses it unchanged after reclaim (PRODUCT_SPEC_v1-demo_1.md:195-201; src/worker/room.ts:596-630,793-810).
- The Product Spec calls several operations presenter actions and says each human sees only their routing row, while server authorisation is any human and snapshots contain all rows (PRODUCT_SPEC_v1-demo_1.md:226-237,263-273; src/worker/room.ts:383-452,820-855).
- moqtail internals, generated dist, relay, Cloudflare platform logging and deployed bindings are outside the authorised inventory.

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [Room creation and joining disclose a relay-wide publish/subscribe bearer](#finding-1) | high | medium | inline below |
| [Any joined human can execute presenter and AI lifecycle controls](#finding-2) | high | high | inline below |
| [Unvalidated AI identifiers can wedge or pre-empt the global floor](#finding-3) | medium | high | inline below |
| [Unthrottled open-room joins permit unbounded participant and routing allocation](#finding-4) | medium | high | inline below |
| [One participant token can open unbounded concurrent control sockets](#finding-5) | medium | high | inline below |
| [Public room snapshots disclose every human's per-AI routing preferences](#finding-6) | medium | high | inline below |
| [Unknown room-code probes initialise persistent SQLite Durable Objects](#finding-7) | medium | high | inline below |
| [Media bursts trigger count-unbounded sorting and decoder submission](#finding-8) | medium | high | inline below |
| [A reusable participant bearer is placed in the WebSocket query string](#finding-9) | medium | medium | inline below |
| [Narrow read-only clients still start microphone capture and publication](#finding-10) | medium | medium | inline below |
| [Playback deduplication retains unbounded object identifiers per group](#finding-11) | medium | high | inline below |
| [Worker parses unbounded JSON bodies before rate limiting or authentication](#finding-12) | medium | high | inline below |
| [Any participant can spoof another participant's activity](#finding-13) | low | high | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Room creation and joining disclose a relay-wide publish/subscribe bearer

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | medium |
| Confidence rationale | The unscoped credential flow and caller-controlled adapter operations are direct source facts. Actual relay acceptance, ACLs, expiry and duplicate-publication semantics remain unverified. |
| Category | broken-access-control |
| CWE | CWE-522 |
| Affected lines | src/worker/index.ts:98-114, src/worker/index.ts:289-304, src/worker/relayCredential.ts:10-13, src/client/transport/MoqTransportAdapter.ts:361-483 |

#### Summary

The public create route and open join route return the same configured MOQ_RELAY_TOKEN to browsers. The adapter then authenticates relay operations with that bearer without room, participant, track, action or expiry claims.

#### Root Cause

A single Worker secret is treated as a browser credential; no server component mints or enforces room-, participant-, publication- or subscription-specific claims.

**Worker returns the configured token** — `src/worker/index.ts:289-304`

The application explicitly describes relay-wide authority and returns the configured secret unchanged.

```typescript
This token grants publish and subscribe access at the relay, so routing stays
 * labelled cooperative. The current Cloudflare token API cannot mint the
 * room- and track-scoped credentials the long-term design calls for.
 */
function relayCredential(env: Env): string | null {
  const endpoint = configValue(env.MOQ_RELAY_URL);
  if (!endpoint) return null;
  return configuredRelayCredential(env.MOQ_RELAY_TOKEN);
}
```

**Public create response includes the bearer** — `src/worker/index.ts:98-114`

Room creation requires no existing participant authority yet returns the relay bearer.

```typescript
if (request.method === "POST" && url.pathname === "/api/rooms") {
  const body = await readJsonObject(request);
  const displayName = requiredString(body, "displayName", 80);
  await enforceCreationRateLimit(request, env);
  const code = roomCode();
  const stub = roomStub(env, code);
  await stub.initialise(code, Date.now());
  const joined = await stub.join(displayName);
  return json<CreateRoomResponse>({
    ...joined,
    relayCredential: relayCredential(env),
    correlationId,
  }, 201);
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Worker returns the configured token** — `src/worker/index.ts:289-304`

The application explicitly describes relay-wide authority and returns the configured secret unchanged.

```typescript
This token grants publish and subscribe access at the relay, so routing stays
 * labelled cooperative. The current Cloudflare token API cannot mint the
 * room- and track-scoped credentials the long-term design calls for.
 */
function relayCredential(env: Env): string | null {
  const endpoint = configValue(env.MOQ_RELAY_URL);
  if (!endpoint) return null;
  return configuredRelayCredential(env.MOQ_RELAY_TOKEN);
}
```

**Public create response includes the bearer** — `src/worker/index.ts:98-114`

Room creation requires no existing participant authority yet returns the relay bearer.

```typescript
if (request.method === "POST" && url.pathname === "/api/rooms") {
  const body = await readJsonObject(request);
  const displayName = requiredString(body, "displayName", 80);
  await enforceCreationRateLimit(request, env);
  const code = roomCode();
  const stub = roomStub(env, code);
  await stub.initialise(code, Date.now());
  const joined = await stub.join(displayName);
  return json<CreateRoomResponse>({
    ...joined,
    relayCredential: relayCredential(env),
    correlationId,
  }, 201);
}
```

Assertions:
- Both create and join return relayCredential(env).
- configuredRelayCredential returns the trimmed Worker secret unchanged.
- MoqTransportAdapter accepts caller-selected publication, subscription and namespace targets.

Counterevidence and remaining uncertainty:
- Responses are no-store; the token is absent from RoomSnapshot, logs and telemetry.
- Room codes and participant identifiers are high entropy.
- Routing is truthfully labelled cooperative and transport is unverified.

Limitations:
- Successful relay abuse was not run because live relay acceptance is outside the authorised source snapshot.

#### Dataflow

The canonical finding records the affected path at src/worker/index.ts:98-114, src/worker/index.ts:289-304, src/worker/relayCredential.ts:10-13, src/client/transport/MoqTransportAdapter.ts:361-483, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Call public POST /api/rooms.
- Read relayCredential from the response.
- Authenticate a modified MOQT client with the bearer.
- Request arbitrary publish or subscribe addresses.

**Worker returns the configured token** — `src/worker/index.ts:289-304`

The application explicitly describes relay-wide authority and returns the configured secret unchanged.

```typescript
This token grants publish and subscribe access at the relay, so routing stays
 * labelled cooperative. The current Cloudflare token API cannot mint the
 * room- and track-scoped credentials the long-term design calls for.
 */
function relayCredential(env: Env): string | null {
  const endpoint = configValue(env.MOQ_RELAY_URL);
  if (!endpoint) return null;
  return configuredRelayCredential(env.MOQ_RELAY_TOKEN);
}
```

**Public create response includes the bearer** — `src/worker/index.ts:98-114`

Room creation requires no existing participant authority yet returns the relay bearer.

```typescript
if (request.method === "POST" && url.pathname === "/api/rooms") {
  const body = await readJsonObject(request);
  const displayName = requiredString(body, "displayName", 80);
  await enforceCreationRateLimit(request, env);
  const code = roomCode();
  const stub = roomStub(env, code);
  await stub.initialise(code, Date.now());
  const joined = await stub.join(displayName);
  return json<CreateRoomResponse>({
    ...joined,
    relayCredential: relayCredential(env),
    correlationId,
  }, 201);
}
```

#### Reachability

An Internet caller creates a room, receives the global relay bearer, and uses a modified client to request relay operations outside application routing.

Preconditions:
- A relay endpoint and MOQ_RELAY_TOKEN are configured.
- The relay accepts the documented publish/subscribe authority.

Existing controls:
- Responses are no-store; the token is absent from RoomSnapshot, logs and telemetry.
- Room codes and participant identifiers are high entropy.
- Routing is truthfully labelled cooperative and transport is unverified.

Limitations:
- Successful relay abuse was not run because live relay acceptance is outside the authorised source snapshot.

#### Severity

**High** — A public caller can obtain authority intended to publish and subscribe at the relay, bypassing all client-only routing controls. This compromises the primary media isolation boundary if the configured relay accepts the documented token authority.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** Successful abuse can expose or spoof room audio and disrupt every connected participant; cross-room reach depends on external namespace and relay behaviour.

Likelihood assessment:
- **Level:** medium
- **Rationale:** medium

#### Remediation

Replace the shared browser-visible token with short-lived credentials scoped to one opaque room and participant, authorising only the participant's publication track and server-approved subscriptions. If the relay cannot enforce that scope, keep live transport unavailable or add an enforcing relay boundary, then rotate the shared secret.

Tests:
- Verify create and join return distinct short-lived credentials.
- Attempt publication outside the participant's own namespace and assert relay denial.
- Toggle routing consent and assert a revoked subscription is rejected at the relay.

Preventive controls:
- Automated check forbidding Worker secret passthrough into API responses.
- Credential claims and expiry audit logging without token values.
- Live relay acceptance tests for namespace ownership and revocation.

<a id="finding-2"></a>

### [2] Any joined human can execute presenter and AI lifecycle controls

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | The public routes, Durable Object mutations and shared assertHuman guard are directly visible, and the product specification explicitly identifies presenter-only operations. |
| Category | missing-authorization |
| CWE | CWE-862 |
| Affected lines | src/worker/index.ts:167-252, src/worker/room.ts:187-245, src/worker/room.ts:314-452, src/worker/room.ts:785-810 |

#### Summary

All AI creation, removal, pipeline, presenter-simulation and AI-to-AI administration methods authorise through assertHuman, which distinguishes only human from AI. The server stores no creator, presenter, owner or per-AI worker authority.

#### Root Cause

Global room mutations rely on a role predicate that verifies only human membership, while presenterMode is client-side UI state and no stronger server principal exists.

**AI creation accepts any human** — `src/worker/room.ts:187-219`

The only authority check for creating room-wide AIs is membership as any human.

```typescript
async addAi(
  credential: ParticipantCredential,
  displayName: string,
  options: { address?: string; wakeName?: string; simulated?: boolean } = {},
): Promise<RoomSnapshot> {
  await this.assertHuman(credential);
  return this.addAiInternal(displayName, options);
}
```

**Shared guard has no presenter role** — `src/worker/room.ts:785-790`

The central guard cannot distinguish the room creator, presenter, AI worker or an ordinary attendee.

```typescript
private async assertHuman(credential: ParticipantCredential): Promise<ParticipantRow> {
  const row = await this.assertParticipant(credential.participantId, credential.rejoinToken);
  if (row.role !== "human") {
    throw roomError(403, "human_only", "Only a human participant can perform this action.");
  }
  return row;
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**AI creation accepts any human** — `src/worker/room.ts:187-219`

The only authority check for creating room-wide AIs is membership as any human.

```typescript
async addAi(
  credential: ParticipantCredential,
  displayName: string,
  options: { address?: string; wakeName?: string; simulated?: boolean } = {},
): Promise<RoomSnapshot> {
  await this.assertHuman(credential);
  return this.addAiInternal(displayName, options);
}
```

**Shared guard has no presenter role** — `src/worker/room.ts:785-790`

The central guard cannot distinguish the room creator, presenter, AI worker or an ordinary attendee.

```typescript
private async assertHuman(credential: ParticipantCredential): Promise<ParticipantRow> {
  const row = await this.assertParticipant(credential.participantId, credential.rejoinToken);
  if (row.role !== "human") {
    throw roomError(403, "human_only", "Only a human participant can perform this action.");
  }
  return row;
}
```

Assertions:
- A second joined human receives a credential accepted by addAi, removeAi, setAiPipeline, setAiToAi and configurePresenter.
- No owner/presenter field or capability is persisted.
- Client sessionStorage changes only UI visibility.

Counterevidence and remaining uncertainty:
- A valid high-entropy participant credential is required.
- Simulation counts and AI-to-AI turns are bounded.
- Rooms hard-stop after twenty minutes and no live AI workers exist yet.

Limitations:
- External AI cost impact is prospective because the revision uses labelled presenter simulation only.

#### Dataflow

The canonical finding records the affected path at src/worker/index.ts:167-252, src/worker/room.ts:187-245, src/worker/room.ts:314-452, src/worker/room.ts:785-810, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Join the open room as an ordinary human.
- Read AI identifiers from the snapshot.
- Call AI lifecycle, pipeline, presenter or AI-to-AI routes.
- The server applies and broadcasts global state changes.

**AI creation accepts any human** — `src/worker/room.ts:187-219`

The only authority check for creating room-wide AIs is membership as any human.

```typescript
async addAi(
  credential: ParticipantCredential,
  displayName: string,
  options: { address?: string; wakeName?: string; simulated?: boolean } = {},
): Promise<RoomSnapshot> {
  await this.assertHuman(credential);
  return this.addAiInternal(displayName, options);
}
```

**Shared guard has no presenter role** — `src/worker/room.ts:785-790`

The central guard cannot distinguish the room creator, presenter, AI worker or an ordinary attendee.

```typescript
private async assertHuman(credential: ParticipantCredential): Promise<ParticipantRow> {
  const row = await this.assertParticipant(credential.participantId, credential.rejoinToken);
  if (row.role !== "human") {
    throw roomError(403, "human_only", "Only a human participant can perform this action.");
  }
  return row;
}
```

#### Reachability

A room-code holder joins normally, then sends global mutation requests with their own participant credential; assertHuman authorises each operation and the Durable Object broadcasts the altered state.

Preconditions:
- The attacker knows the non-guessable room code and completes an ordinary join.

Existing controls:
- A valid high-entropy participant credential is required.
- Simulation counts and AI-to-AI turns are bounded.
- Rooms hard-stop after twenty minutes and no live AI workers exist yet.

Limitations:
- External AI cost impact is prospective because the revision uses labelled presenter simulation only.

#### Severity

**High** — An ordinary attendee can corrupt or remove the complete AI cast, change global safety state and interrupt the ten-minute stage demonstration for every participant.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** The attacker can remove legitimate AIs, fabricate shared AI state, reshape the simulated cast and manipulate AI-to-AI safety counters, breaking the demo's integrity and availability.

Likelihood assessment:
- **Level:** high
- **Rationale:** high

#### Remediation

Persist a room owner/presenter capability at creation, support deliberate delegation, require it for presenter and AI lifecycle administration, and issue per-AI worker credentials for pipeline heartbeats. Add per-room AI mutation and cost budgets without capping ordinary human membership.

Tests:
- Create a room, join a second human, and assert 403 for every global presenter/AI operation.
- Assert a valid presenter capability succeeds and can be revoked.
- Assert per-AI credentials can update only their bound AI pipeline.

Preventive controls:
- Central authorisation policy for room-global actions.
- Negative cross-participant tests for every new RPC.
- Explicit AI lifecycle and cost budgets.

<a id="finding-3"></a>

### [3] Unvalidated AI identifiers can wedge or pre-empt the global floor

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The missing target lookup and direct SQL writes are explicit in source; no foreign key or turn capability exists. |
| Category | improper-input-validation |
| CWE | CWE-20 |
| Affected lines | src/worker/index.ts:207-216, src/worker/room.ts:336-381, src/worker/room.ts:586-589 |

#### Summary

requestFloor stores an arbitrary caller-supplied aiId as the floor holder or queue entry without proving that it names an active AI. releaseFloor likewise needs only the supplied holder ID.

#### Root Cause

The floor API trusts an identifier asserted by a human caller and the database schema does not bind floor holders or queue entries to active AI participant rows.

**Caller target is stored without validation** — `src/worker/room.ts:336-360`

No participant existence, role or state check occurs before the supplied identifier becomes shared floor state.

```typescript
async requestFloor(
  credential: ParticipantCredential,
  aiId: string,
): Promise<{ granted: boolean; room: RoomSnapshot }> {
  await this.assertHuman(credential);
  this.assertActive();
  const now = Date.now();
  const meta = this.meta();
  if (!meta) throw roomError(404, "room_not_found", "Room is not initialised.");

  if (meta.floor_holder === aiId) return { granted: true, room: this.snapshot() };
  if (meta.floor_holder === null) {
    this.ctx.storage.sql.exec(
      "UPDATE room_meta SET floor_holder = ?, floor_since = ? WHERE singleton = 1",
      aiId,
      now,
    );
  }
  this.ctx.storage.sql.exec(
    "INSERT INTO floor_queue (ai_id, queued_at) VALUES (?, ?) ON CONFLICT(ai_id) DO NOTHING",
    aiId,
    now,
  );
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Caller target is stored without validation** — `src/worker/room.ts:336-360`

No participant existence, role or state check occurs before the supplied identifier becomes shared floor state.

```typescript
async requestFloor(
  credential: ParticipantCredential,
  aiId: string,
): Promise<{ granted: boolean; room: RoomSnapshot }> {
  await this.assertHuman(credential);
  this.assertActive();
  const now = Date.now();
  const meta = this.meta();
  if (!meta) throw roomError(404, "room_not_found", "Room is not initialised.");

  if (meta.floor_holder === aiId) return { granted: true, room: this.snapshot() };
  if (meta.floor_holder === null) {
    this.ctx.storage.sql.exec(
      "UPDATE room_meta SET floor_holder = ?, floor_since = ? WHERE singleton = 1",
      aiId,
      now,
    );
  }
  this.ctx.storage.sql.exec(
    "INSERT INTO floor_queue (ai_id, queued_at) VALUES (?, ?) ON CONFLICT(ai_id) DO NOTHING",
    aiId,
    now,
  );
}
```

Assertions:
- Nonexistent and human identifiers are accepted as floor holders.
- releaseFloor has no proof that the caller controls the active AI turn.
- floor_queue has only a text primary key.

Counterevidence and remaining uncertainty:
- A valid human credential is required.
- Duplicate queue identifiers are deduplicated.
- Removing a known AI cleans its own floor state.

#### Dataflow

The canonical finding records the affected path at src/worker/index.ts:207-216, src/worker/room.ts:336-381, src/worker/room.ts:586-589, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Join as a human.
- Request the floor for a nonexistent identifier while the floor is empty.
- Legitimate AIs subsequently queue behind the unreachable holder.

**Caller target is stored without validation** — `src/worker/room.ts:336-360`

No participant existence, role or state check occurs before the supplied identifier becomes shared floor state.

```typescript
async requestFloor(
  credential: ParticipantCredential,
  aiId: string,
): Promise<{ granted: boolean; room: RoomSnapshot }> {
  await this.assertHuman(credential);
  this.assertActive();
  const now = Date.now();
  const meta = this.meta();
  if (!meta) throw roomError(404, "room_not_found", "Room is not initialised.");

  if (meta.floor_holder === aiId) return { granted: true, room: this.snapshot() };
  if (meta.floor_holder === null) {
    this.ctx.storage.sql.exec(
      "UPDATE room_meta SET floor_holder = ?, floor_since = ? WHERE singleton = 1",
      aiId,
      now,
    );
  }
  this.ctx.storage.sql.exec(
    "INSERT INTO floor_queue (ai_id, queued_at) VALUES (?, ?) ON CONFLICT(ai_id) DO NOTHING",
    aiId,
    now,
  );
}
```

#### Reachability

An ordinary human calls the floor route with a fabricated or known aiId; the Durable Object stores or releases that identifier without target validation.

Preconditions:
- The attacker is an active human participant.

Existing controls:
- A valid human credential is required.
- Duplicate queue identifiers are deduplicated.
- Removing a known AI cleans its own floor state.

#### Severity

**Medium** — A joined human can block every legitimate AI behind a nonexistent holder, fill the queue with bogus identifiers or release another AI's turn, disrupting shared room availability.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** Shared AI turn-taking is wedged or pre-empted until another caller supplies the exact bogus holder or the room expires.

Likelihood assessment:
- **Level:** high
- **Rationale:** high

#### Remediation

Resolve aiId to an active role='ai' participant before every floor operation. Bind acquisition and release to an authorised AI or server-issued turn capability, reject stale requests and constrain the queue to active AI rows.

Tests:
- Reject nonexistent, human, left and simulated-disallowed targets.
- Require a valid turn capability to release the holder.
- Verify queue rows reference active AI participants after lifecycle changes.

Preventive controls:
- Foreign-key or application invariant for floor targets.
- Capability-bound floor API.
- Invariant tests for every participant state transition.

<a id="finding-4"></a>

### [4] Unthrottled open-room joins permit unbounded participant and routing allocation

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The absence of a join limiter and the per-join allocations are explicit. The product's no-participant-cap rule does not prohibit velocity limits. |
| Category | resource-exhaustion |
| CWE | CWE-770 |
| Affected lines | src/worker/index.ts:132-143, src/worker/room.ts:143-180, src/worker/room.ts:633-660, src/worker/room.ts:820-855 |

#### Summary

The open join path has no source- or room-level rate limit. Every non-reclaim join inserts a participant, seeds routing for every AI, broadcasts and serialises a complete snapshot; the Worker also fetched a snapshot immediately before joining.

#### Root Cause

Only room creation is throttled; open membership was implemented without a separate abuse-velocity and credential-issuance budget.

**Each request creates persistent participant state** — `src/worker/room.ts:148-180`

Every fresh join performs persistent writes, cross-product routing work, a broadcast and a growing snapshot.

```typescript
async join(displayName: string, rejoinToken?: string): Promise<RoomJoinResult> {
  this.assertActive();
  const now = Date.now();
  if (rejoinToken) {
    const reclaimed = await this.reclaim(displayName, rejoinToken, now);
    if (reclaimed) return reclaimed;
  }
  const participantId = crypto.randomUUID();
  const token = randomToken();
  this.ctx.storage.sql.exec(
    `INSERT INTO participants (id, display_name, role, state, joined_at, reconnect_until, rejoin_hash, simulated, address, wake_name, pipeline, last_active_at)
     VALUES (?, ?, 'human', 'connected', ?, NULL, ?, 0, NULL, NULL, NULL, ?)`,
    participantId, displayName, now, await sha256(token), now,
  );
  this.seedRoutingForHuman(participantId, now);
  this.broadcast({ type: "participant_changed", participantId, state: "connected", at: now });
  return { room: this.snapshot(), participant: this.participant(participantId), rejoinToken: token };
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Each request creates persistent participant state** — `src/worker/room.ts:148-180`

Every fresh join performs persistent writes, cross-product routing work, a broadcast and a growing snapshot.

```typescript
async join(displayName: string, rejoinToken?: string): Promise<RoomJoinResult> {
  this.assertActive();
  const now = Date.now();
  if (rejoinToken) {
    const reclaimed = await this.reclaim(displayName, rejoinToken, now);
    if (reclaimed) return reclaimed;
  }
  const participantId = crypto.randomUUID();
  const token = randomToken();
  this.ctx.storage.sql.exec(
    `INSERT INTO participants (id, display_name, role, state, joined_at, reconnect_until, rejoin_hash, simulated, address, wake_name, pipeline, last_active_at)
     VALUES (?, ?, 'human', 'connected', ?, NULL, ?, 0, NULL, NULL, NULL, ?)`,
    participantId, displayName, now, await sha256(token), now,
  );
  this.seedRoutingForHuman(participantId, now);
  this.broadcast({ type: "participant_changed", participantId, state: "connected", at: now });
  return { room: this.snapshot(), participant: this.participant(participantId), rejoinToken: token };
}
```

Assertions:
- No join limiter is invoked.
- Each new human creates routing rows for all active AIs.
- Every join broadcasts and returns the full snapshot.

Counterevidence and remaining uncertainty:
- The attacker must know a high-entropy room code.
- Input lengths and room lifetime are bounded.
- Membership intentionally has no count cap.

Limitations:
- Cloudflare object and request ceilings were not measured.

#### Dataflow

The canonical finding records the affected path at src/worker/index.ts:132-143, src/worker/room.ts:143-180, src/worker/room.ts:633-660, src/worker/room.ts:820-855, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Obtain a valid room code.
- Send many join requests without reclaim tokens.
- Each request allocates participant and routing state.
- Snapshot and broadcast work grows with accumulated state.

**Each request creates persistent participant state** — `src/worker/room.ts:148-180`

Every fresh join performs persistent writes, cross-product routing work, a broadcast and a growing snapshot.

```typescript
async join(displayName: string, rejoinToken?: string): Promise<RoomJoinResult> {
  this.assertActive();
  const now = Date.now();
  if (rejoinToken) {
    const reclaimed = await this.reclaim(displayName, rejoinToken, now);
    if (reclaimed) return reclaimed;
  }
  const participantId = crypto.randomUUID();
  const token = randomToken();
  this.ctx.storage.sql.exec(
    `INSERT INTO participants (id, display_name, role, state, joined_at, reconnect_until, rejoin_hash, simulated, address, wake_name, pipeline, last_active_at)
     VALUES (?, ?, 'human', 'connected', ?, NULL, ?, 0, NULL, NULL, NULL, ?)`,
    participantId, displayName, now, await sha256(token), now,
  );
  this.seedRoutingForHuman(participantId, now);
  this.broadcast({ type: "participant_changed", participantId, state: "connected", at: now });
  return { room: this.snapshot(), participant: this.participant(participantId), rejoinToken: token };
}
```

#### Reachability

A room-code holder sends rapid fresh joins, causing persistent state and per-event work to grow faster than legitimate clients can be served.

Preconditions:
- The attacker knows the room code.

Existing controls:
- The attacker must know a high-entropy room code.
- Input lengths and room lifetime are bounded.
- Membership intentionally has no count cap.

Limitations:
- Cloudflare object and request ceilings were not measured.

#### Severity

**Medium** — A room-code holder can grow participant and human-by-AI routing state and amplify snapshots/broadcasts fast enough to degrade or exhaust a room Durable Object.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** The room control plane slows or becomes unavailable without rejecting any individual join for participant count.

Likelihood assessment:
- **Level:** high
- **Rationale:** high

#### Remediation

Add per-source and per-room token-bucket join limits with documented burst capacity and Retry-After. Rate-limit relay credential issuance separately, avoid duplicate snapshot serialisation, and budget routing-row creation while preserving the no-participant-count-cap requirement.

Tests:
- Burst joins from one source and one room and assert rate-limited responses with Retry-After.
- Verify legitimate joins resume after refill.
- Verify the implementation never rejects solely because of total participant count.

Preventive controls:
- Dedicated join and credential-issuance rate limits.
- Per-room work-budget telemetry.
- Load test for human-by-AI routing growth.

<a id="finding-5"></a>

### [5] One participant token can open unbounded concurrent control sockets

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The upgrade allocation and broadcast iteration are direct source paths; no local throttle, ticket consumption or concurrency check exists. |
| Category | resource-exhaustion |
| CWE | CWE-770 |
| Affected lines | src/worker/index.ts:263-280, src/worker/room.ts:466-496, src/worker/room.ts:969-972 |

#### Summary

Every authenticated events upgrade creates and retains another WebSocket, sends a full snapshot and includes it in every later broadcast. The participant tag is never used to enforce a per-participant concurrency bound.

#### Root Cause

The reusable participant credential is accepted independently for every upgrade and no per-participant connection ownership or bounded reconnect policy is enforced.

**Each token replay allocates another socket** — `src/worker/room.ts:466-496`

The participant tag is recorded but not checked against existing sockets.

```typescript
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const participantId = url.searchParams.get("participant") ?? "";
  const rejoinToken = url.searchParams.get("token") ?? "";
  await this.assertParticipant(participantId, rejoinToken);

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.serializeAttachment({ participantId } satisfies SocketAttachment);
  this.ctx.acceptWebSocket(server, [`participant:${participantId}`]);
  server.send(JSON.stringify({ type: "snapshot", room: this.snapshot(), at: Date.now() }));
  return new Response(null, { status: 101, webSocket: client });
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Each token replay allocates another socket** — `src/worker/room.ts:466-496`

The participant tag is recorded but not checked against existing sockets.

```typescript
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const participantId = url.searchParams.get("participant") ?? "";
  const rejoinToken = url.searchParams.get("token") ?? "";
  await this.assertParticipant(participantId, rejoinToken);

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.serializeAttachment({ participantId } satisfies SocketAttachment);
  this.ctx.acceptWebSocket(server, [`participant:${participantId}`]);
  server.send(JSON.stringify({ type: "snapshot", room: this.snapshot(), at: Date.now() }));
  return new Response(null, { status: 101, webSocket: client });
}
```

Assertions:
- The same credential can authenticate repeated upgrades.
- Each upgrade serialises and sends a full snapshot.
- broadcast sends to every retained socket.

Counterevidence and remaining uncertainty:
- A valid active participant credential is required.
- Only ping messages are accepted from clients.
- Room expiry closes sockets and platform quotas may cap absolute scale.

Limitations:
- Cloudflare connection ceilings were not inspected.

#### Dataflow

The canonical finding records the affected path at src/worker/index.ts:263-280, src/worker/room.ts:466-496, src/worker/room.ts:969-972, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Join once.
- Open many concurrent /events upgrades with the same credential.
- Trigger or wait for room events.
- Observe work amplified over all sockets.

**Each token replay allocates another socket** — `src/worker/room.ts:466-496`

The participant tag is recorded but not checked against existing sockets.

```typescript
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const participantId = url.searchParams.get("participant") ?? "";
  const rejoinToken = url.searchParams.get("token") ?? "";
  await this.assertParticipant(participantId, rejoinToken);

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.serializeAttachment({ participantId } satisfies SocketAttachment);
  this.ctx.acceptWebSocket(server, [`participant:${participantId}`]);
  server.send(JSON.stringify({ type: "snapshot", room: this.snapshot(), at: Date.now() }));
  return new Response(null, { status: 101, webSocket: client });
}
```

#### Reachability

A malicious participant replays their valid token across many WebSocket upgrades; later room events are multiplied across every retained socket.

Preconditions:
- The attacker has one valid participant credential.

Existing controls:
- A valid active participant credential is required.
- Only ping messages are accepted from clients.
- Room expiry closes sockets and platform quotas may cap absolute scale.

Limitations:
- Cloudflare connection ceilings were not inspected.

#### Severity

**Medium** — A single participant can amplify Durable Object connection, serialisation and broadcast work until the control plane becomes unavailable during the demo.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** Control-plane resources and broadcast capacity are exhausted for the room.

Likelihood assessment:
- **Level:** high
- **Rationale:** high

#### Remediation

Use single-use socket tickets, enforce one active socket or a small documented bound per participant, close or replace the older socket on reconnect, rate-limit upgrades and bound initial snapshot/broadcast work.

Tests:
- Open a second socket for one participant and assert replacement or 429.
- Burst upgrades and assert a documented Retry-After response.
- Verify broadcasts target only the authorised active socket.

Preventive controls:
- Per-participant socket registry.
- Single-use upgrade tickets.
- Connection and broadcast metrics with bounded degradation.

<a id="finding-6"></a>

### [6] Public room snapshots disclose every human's per-AI routing preferences

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The public GET route, unrestricted routing query and returned contract are direct source facts, and the privacy requirement is explicit. |
| Category | sensitive-data-exposure |
| CWE | CWE-200 |
| Affected lines | src/worker/index.ts:117-130, src/worker/room.ts:466-496, src/worker/room.ts:820-855, src/worker/room.ts:991-999 |

#### Summary

The unauthenticated room snapshot selects and serialises all routing rows, including who permits each AI to hear them and who listens to each AI. Join responses and control WebSockets reuse the same complete snapshot.

#### Root Cause

One viewer-independent RoomSnapshot is used for public HTTP, join and WebSocket responses even though routing preferences contain per-human private consent state.

**Snapshot returns every routing row** — `src/worker/room.ts:820-837`

The snapshot has no viewer context and therefore cannot filter detailed rows to their owner.

```typescript
private snapshot(): RoomSnapshot {
  const meta = this.assertActive();
  const participants = this.ctx.storage.sql
    .exec<ParticipantRow>("SELECT * FROM participants WHERE state != 'left' ORDER BY joined_at")
    .toArray()
    .map(toParticipant);
  const routing = this.ctx.storage.sql
    .exec<RoutingRow>("SELECT * FROM routing ORDER BY updated_at")
    .toArray()
    .map((row) => toRouting(row, this.routingEnforcement()));

  return {
    code: meta.code,
    participants,
    routing,
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Snapshot returns every routing row** — `src/worker/room.ts:820-837`

The snapshot has no viewer context and therefore cannot filter detailed rows to their owner.

```typescript
private snapshot(): RoomSnapshot {
  const meta = this.assertActive();
  const participants = this.ctx.storage.sql
    .exec<ParticipantRow>("SELECT * FROM participants WHERE state != 'left' ORDER BY joined_at")
    .toArray()
    .map(toParticipant);
  const routing = this.ctx.storage.sql
    .exec<RoutingRow>("SELECT * FROM routing ORDER BY updated_at")
    .toArray()
    .map((row) => toRouting(row, this.routingEnforcement()));

  return {
    code: meta.code,
    participants,
    routing,
```

Assertions:
- GET by room code requires no participant credential.
- snapshot executes SELECT \* FROM routing.
- toRouting exposes humanId, aiId, hearsMe and iHearIt.

Counterevidence and remaining uncertainty:
- The room code is high entropy and acts as a share capability.
- Tokens and relay credentials are absent.
- Room state expires after twenty minutes.

#### Dataflow

The canonical finding records the affected path at src/worker/index.ts:117-130, src/worker/room.ts:466-496, src/worker/room.ts:820-855, src/worker/room.ts:991-999, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Obtain an invited room link.
- Request GET /api/rooms/:code.
- Correlate participants with routing rows.

**Snapshot returns every routing row** — `src/worker/room.ts:820-837`

The snapshot has no viewer context and therefore cannot filter detailed rows to their owner.

```typescript
private snapshot(): RoomSnapshot {
  const meta = this.assertActive();
  const participants = this.ctx.storage.sql
    .exec<ParticipantRow>("SELECT * FROM participants WHERE state != 'left' ORDER BY joined_at")
    .toArray()
    .map(toParticipant);
  const routing = this.ctx.storage.sql
    .exec<RoutingRow>("SELECT * FROM routing ORDER BY updated_at")
    .toArray()
    .map((row) => toRouting(row, this.routingEnforcement()));

  return {
    code: meta.code,
    participants,
    routing,
```

#### Reachability

A person holding the room code calls the public snapshot endpoint and receives all participant identities and detailed routing rows.

Preconditions:
- The attacker knows a valid room code.

Existing controls:
- The room code is high entropy and acts as a share capability.
- Tokens and relay credentials are absent.
- Room state expires after twenty minutes.

#### Severity

**Medium** — A room-code holder can map display names and participant IDs to individual consent/listening choices that the binding product specification says are owner-only.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** Individual AI consent and listening choices are exposed to every invited room-code holder.

Likelihood assessment:
- **Level:** high
- **Rationale:** high

#### Remediation

Create separate public and participant-specific snapshots. Authenticate detailed routing reads, return only rows owned by the caller, and expose a server-computed aggregate 'Partial context' state for everyone else.

Tests:
- Assert unauthenticated snapshots contain only public aggregate routing state.
- Assert each authenticated human receives only their own detailed rows.
- Assert WebSocket snapshots apply the same viewer-specific filtering.

Preventive controls:
- Separate public/private response types.
- Field-level privacy tests tied to the product specification.
- Schema review for any future snapshot field.

<a id="finding-7"></a>

### [7] Unknown room-code probes initialise persistent SQLite Durable Objects

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The deterministic namespace mapping, constructor migration and persistent SQL writes are direct source facts; only the platform's precise cost is external. |
| Category | resource-exhaustion |
| CWE | CWE-770 |
| Affected lines | src/worker/index.ts:117-130, src/worker/index.ts:313-320, src/worker/room.ts:106-112, src/worker/room.ts:535-594 |

#### Summary

Any syntactically valid room code is mapped with getByName before existence is known. Constructing that Room always runs migrate, creating tables and schema_meta even though no room_meta row or cleanup alarm exists.

#### Root Cause

Room-code existence is checked only after resolving the attacker-selected code into a stateful Durable Object whose constructor performs persistent migration.

**Every object construction migrates SQLite** — `src/worker/room.ts:106-112`

Unknown-room lookup invokes the same constructor as real room creation.

```typescript
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }
}
```

**Migration writes schema metadata** — `src/worker/room.ts:535-593`

The unknown object receives persistent SQLite schema state even though the room is never initialised.

```typescript
private migrate(): void {
  const sql = this.ctx.storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)");
  const current = sql.exec<{ version: number }>("SELECT version FROM schema_meta LIMIT 1").toArray()[0]?.version ?? 0;
  if (current === SCHEMA_VERSION) return;
  // creates room_meta, participants, routing, floor_queue and rate_events
  sql.exec("DELETE FROM schema_meta");
  sql.exec("INSERT INTO schema_meta (version) VALUES (?)", SCHEMA_VERSION);
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Every object construction migrates SQLite** — `src/worker/room.ts:106-112`

Unknown-room lookup invokes the same constructor as real room creation.

```typescript
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }
}
```

**Migration writes schema metadata** — `src/worker/room.ts:535-593`

The unknown object receives persistent SQLite schema state even though the room is never initialised.

```typescript
private migrate(): void {
  const sql = this.ctx.storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)");
  const current = sql.exec<{ version: number }>("SELECT version FROM schema_meta LIMIT 1").toArray()[0]?.version ?? 0;
  if (current === SCHEMA_VERSION) return;
  // creates room_meta, participants, routing, floor_queue and rate_events
  sql.exec("DELETE FROM schema_meta");
  sql.exec("INSERT INTO schema_meta (version) VALUES (?)", SCHEMA_VERSION);
}
```

Assertions:
- The route regex accepts arbitrary valid-looking 20-character codes.
- getByName is invoked before getSnapshot can return null.
- The constructor always runs migrate and writes schema_meta.
- No expiry alarm exists without room_meta.

Counterevidence and remaining uncertainty:
- No room_meta, participant or relay credential is created.
- Each schema is small.
- Cloudflare storage lifecycle and billing are external.

Limitations:
- The precise platform billing and quota impact was not verified.

#### Dataflow

The canonical finding records the affected path at src/worker/index.ts:117-130, src/worker/index.ts:313-320, src/worker/room.ts:106-112, src/worker/room.ts:535-594, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Generate a random 20-character code.
- Request the public snapshot route.
- Worker resolves getByName.
- Room constructor migrates persistent SQLite state.
- getSnapshot returns null and HTTP returns 404.

**Every object construction migrates SQLite** — `src/worker/room.ts:106-112`

Unknown-room lookup invokes the same constructor as real room creation.

```typescript
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }
}
```

**Migration writes schema metadata** — `src/worker/room.ts:535-593`

The unknown object receives persistent SQLite schema state even though the room is never initialised.

```typescript
private migrate(): void {
  const sql = this.ctx.storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)");
  const current = sql.exec<{ version: number }>("SELECT version FROM schema_meta LIMIT 1").toArray()[0]?.version ?? 0;
  if (current === SCHEMA_VERSION) return;
  // creates room_meta, participants, routing, floor_queue and rate_events
  sql.exec("DELETE FROM schema_meta");
  sql.exec("INSERT INTO schema_meta (version) VALUES (?)", SCHEMA_VERSION);
}
```

#### Reachability

An unauthenticated caller probes many random valid-looking room codes; each name resolves to a new Room and its constructor writes a SQLite schema before returning 404.

Preconditions:
- The platform materialises Durable Objects on the observed getByName/fetch/RPC path as represented by this source.

Existing controls:
- No room_meta, participant or relay credential is created.
- Each schema is small.
- Cloudflare storage lifecycle and billing are external.

Limitations:
- The precise platform billing and quota impact was not verified.

#### Severity

**Medium** — An unauthenticated caller can generate unlimited valid-looking codes and create persistent object state outside the room-creation limiter, causing storage, billing or availability pressure.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** Large numbers of persistent empty objects can consume account resources outside the intended creation budget.

Likelihood assessment:
- **Level:** high
- **Rationale:** high

#### Remediation

Validate a signed room capability or check a rate-limited room-code registry before getByName. Make unknown-room lookup non-writing and schedule cleanup or deletion for abandoned allocations.

Tests:
- Probe an unknown valid-looking code and assert no persistent object/schema allocation.
- Flood unique unknown codes and assert registry/verification rejects before getByName.
- Verify abandoned allocations receive cleanup.

Preventive controls:
- Stateless signed room-code verification.
- Rate-limited room registry.
- Metrics for unknown-code probes and object creation.

<a id="finding-8"></a>

### [8] Media bursts trigger count-unbounded sorting and decoder submission

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The dynamic array operations and unlimited drain loop are direct source facts; the 200 ms time rule is not a count or byte bound. |
| Category | algorithmic-complexity |
| CWE | CWE-407 |
| Affected lines | src/client/audio/AdaptiveJitterBuffer.ts:36-67, src/client/audio/TrackPlayer.ts:120-136, src/client/audio/TrackPlayer.ts:272-283, src/client/session/RoomSession.ts:776-790 |

#### Summary

Each valid frame entering AdaptiveJitterBuffer performs a linear duplicate scan, append, full sort and time-only prune. Arbitrarily many frames received within 200 ms survive, and TrackPlayer drains all eligible frames into AudioDecoder without a work or queue-depth budget.

#### Root Cause

Latency-only pruning was implemented without maximum frame count, byte count, cadence validation or decoder-work budgets, and an array-sort structure amplifies attacker-controlled bursts.

**Every insert scans, sorts and time-prunes an unbounded array** — `src/client/audio/AdaptiveJitterBuffer.ts:41-66`

Many unique frames with near-identical receipt times evade stale pruning while causing repeated whole-array work.

```typescript
push(frame: BufferedFrame<T>): void {
  if (this.cancelledGroups.has(frame.groupId)) return;
  if (this.frames.some((candidate) => candidate.sequence === frame.sequence)) return;
  this.lastArrivalAt = frame.receivedAt;
  this.frames.push(frame);
  this.frames.sort((left, right) => left.sequence - right.sequence);
  const staleBefore = frame.receivedAt - this.maximumMs;
  const retained = this.frames.filter((candidate) => candidate.receivedAt >= staleBefore);
  this.frames = retained;
}
```

**All eligible frames are submitted without a budget** — `src/client/audio/TrackPlayer.ts:128-136`

There is no per-drain frame count, time budget or AudioDecoder queue check.

```typescript
drain(now: number): void {
  for (;;) {
    const next = this.buffer.pull(now);
    if (!next) break;
    this.concealGapBefore(next.metadata.sequence);
    this.lastPlayedSequence = next.metadata.sequence;
    this.decodeFrame(next.metadata, next.frame);
  }
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Every insert scans, sorts and time-prunes an unbounded array** — `src/client/audio/AdaptiveJitterBuffer.ts:41-66`

Many unique frames with near-identical receipt times evade stale pruning while causing repeated whole-array work.

```typescript
push(frame: BufferedFrame<T>): void {
  if (this.cancelledGroups.has(frame.groupId)) return;
  if (this.frames.some((candidate) => candidate.sequence === frame.sequence)) return;
  this.lastArrivalAt = frame.receivedAt;
  this.frames.push(frame);
  this.frames.sort((left, right) => left.sequence - right.sequence);
  const staleBefore = frame.receivedAt - this.maximumMs;
  const retained = this.frames.filter((candidate) => candidate.receivedAt >= staleBefore);
  this.frames = retained;
}
```

**All eligible frames are submitted without a budget** — `src/client/audio/TrackPlayer.ts:128-136`

There is no per-drain frame count, time budget or AudioDecoder queue check.

```typescript
drain(now: number): void {
  for (;;) {
    const next = this.buffer.pull(now);
    if (!next) break;
    this.concealGapBefore(next.metadata.sequence);
    this.lastPlayedSequence = next.metadata.sequence;
    this.decodeFrame(next.metadata, next.frame);
  }
}
```

Assertions:
- The buffer has no maximum frames or bytes.
- Every insert executes some plus sort plus filter.
- drain loops until no eligible frame remains and decodeFrame does not inspect decodeQueueSize.

Counterevidence and remaining uncertainty:
- Frames older than 200 ms relative to a newer arrival are pruned.
- Individual payload length, cancellation groups, concealment and mixer ring are bounded.
- External Web Streams or relay flow control may reduce bursts.

Limitations:
- The browser threshold and external relay backpressure were not measured.

#### Dataflow

The canonical finding records the affected path at src/client/audio/AdaptiveJitterBuffer.ts:36-67, src/client/audio/TrackPlayer.ts:120-136, src/client/audio/TrackPlayer.ts:272-283, src/client/session/RoomSession.ts:776-790, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Publish unique valid audio envelopes far above 20 ms cadence.
- Automatic human subscriptions deliver the burst.
- Jitter insertion repeatedly scans and sorts.
- Drain submits accumulated frames without queue limits.

**Every insert scans, sorts and time-prunes an unbounded array** — `src/client/audio/AdaptiveJitterBuffer.ts:41-66`

Many unique frames with near-identical receipt times evade stale pruning while causing repeated whole-array work.

```typescript
push(frame: BufferedFrame<T>): void {
  if (this.cancelledGroups.has(frame.groupId)) return;
  if (this.frames.some((candidate) => candidate.sequence === frame.sequence)) return;
  this.lastArrivalAt = frame.receivedAt;
  this.frames.push(frame);
  this.frames.sort((left, right) => left.sequence - right.sequence);
  const staleBefore = frame.receivedAt - this.maximumMs;
  const retained = this.frames.filter((candidate) => candidate.receivedAt >= staleBefore);
  this.frames = retained;
}
```

**All eligible frames are submitted without a budget** — `src/client/audio/TrackPlayer.ts:128-136`

There is no per-drain frame count, time budget or AudioDecoder queue check.

```typescript
drain(now: number): void {
  for (;;) {
    const next = this.buffer.pull(now);
    if (!next) break;
    this.concealGapBefore(next.metadata.sequence);
    this.lastPlayedSequence = next.metadata.sequence;
    this.decodeFrame(next.metadata, next.frame);
  }
}
```

#### Reachability

A joined malicious publisher sends many unique valid objects inside one receipt-time window; every subscriber repeatedly sorts the burst and then submits it to the decoder.

Preconditions:
- The relay delivers the attacker's own track to automatic subscribers.

Existing controls:
- Frames older than 200 ms relative to a newer arrival are pruned.
- Individual payload length, cancellation groups, concealment and mixer ring are bounded.
- External Web Streams or relay flow control may reduce bursts.

Limitations:
- The browser threshold and external relay backpressure were not measured.

#### Severity

**Medium** — A malicious publisher can create superlinear main-thread work, retain many large frame copies and flood the decoder queue across automatically subscribed audience browsers.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** Main-thread stalls, decoder overload, audible failure or tab termination disrupt the demonstration.

Likelihood assessment:
- **Level:** high
- **Rationale:** high

#### Remediation

Use a bounded sequence-indexed ring or heap, cap buffered objects and bytes, validate cadence/sequence/frame size, reject excess before sorting, limit work per drain, gate AudioDecoder.decode on decodeQueueSize and quarantine persistent offenders.

Tests:
- Insert a burst beyond the expected cadence and assert fixed frame/byte bounds.
- Assert excess objects are dropped before sort.
- Drive decodeQueueSize high and assert decode work is deferred or dropped.
- Measure CPU and heap under an adversarial burst.

Preventive controls:
- Bounded receive-pipeline invariants.
- Per-track cadence and byte telemetry.
- Algorithmic-complexity regression tests.

<a id="finding-9"></a>

### [9] A reusable participant bearer is placed in the WebSocket query string

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | URL placement and token reuse are direct source facts, while actual external query-string logging is deployment-dependent and was not established. |
| Category | credential-exposure |
| CWE | CWE-598 |
| Affected lines | src/client/api.ts:187-198, src/worker/index.ts:263-280, src/worker/room.ts:466-496, src/worker/room.ts:596-630 |

#### Summary

roomEventsUrl appends the participant's general rejoin token to the WebSocket URL. The Worker and Durable Object read that query value for authentication, and reclaim returns the same reusable token without consumption or rotation.

#### Root Cause

The socket handshake reuses a general-purpose participant credential instead of exchanging it through an authenticated request for a purpose-bound, single-use socket ticket.

**Client embeds reusable bearer in URL** — `src/client/api.ts:187-198`

The code explicitly treats the URL as secret but places the reusable general bearer in it.

```typescript
/**
 * §8 link separation: the control-plane socket carries the participant token in
 * a query string, so this URL is a secret and never appears in telemetry or a
 * share link.
 */
export function roomEventsUrl(session: StoredSession): string {
  const url = new URL(`/api/rooms/${session.code}/events`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("participant", session.participantId);
  url.searchParams.set("token", session.rejoinToken);
  return url.toString();
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Client embeds reusable bearer in URL** — `src/client/api.ts:187-198`

The code explicitly treats the URL as secret but places the reusable general bearer in it.

```typescript
/**
 * §8 link separation: the control-plane socket carries the participant token in
 * a query string, so this URL is a secret and never appears in telemetry or a
 * share link.
 */
export function roomEventsUrl(session: StoredSession): string {
  const url = new URL(`/api/rooms/${session.code}/events`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("participant", session.participantId);
  url.searchParams.set("token", session.rejoinToken);
  return url.toString();
}
```

Assertions:
- The complete token is appended as token=.
- The same token authenticates other participant mutations.
- Reclaim does not consume or rotate it.

Counterevidence and remaining uncertainty:
- Application logs normalise to pathname and omit queries.
- TLS protects transit.
- The token is random, hashed at rest and bounded by leave or room expiry.

Limitations:
- Cloudflare or proxy full-URL logging was not verified.

#### Dataflow

The canonical finding records the affected path at src/client/api.ts:187-198, src/worker/index.ts:263-280, src/worker/room.ts:466-496, src/worker/room.ts:596-630, but no expanded source-to-sink narrative was recorded.

Attack steps:
- An external component records the WebSocket request URL.
- The attacker reads the token query parameter.
- The attacker opens a socket or invokes HTTP mutations before expiry.

**Client embeds reusable bearer in URL** — `src/client/api.ts:187-198`

The code explicitly treats the URL as secret but places the reusable general bearer in it.

```typescript
/**
 * §8 link separation: the control-plane socket carries the participant token in
 * a query string, so this URL is a secret and never appears in telemetry or a
 * share link.
 */
export function roomEventsUrl(session: StoredSession): string {
  const url = new URL(`/api/rooms/${session.code}/events`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("participant", session.participantId);
  url.searchParams.set("token", session.rejoinToken);
  return url.toString();
}
```

#### Reachability

A party with access to handshake URLs obtains the query bearer and replays it as the participant.

Preconditions:
- At least one external system records full request URLs.
- The participant remains active or inside the reconnect window.

Existing controls:
- Application logs normalise to pathname and omit queries.
- TLS protects transit.
- The token is random, hashed at rest and bounded by leave or room expiry.

Limitations:
- Cloudflare or proxy full-URL logging was not verified.

#### Severity

**Medium** — If an intermediary, diagnostic or access log captures the handshake URL, its reader can replay the participant's general credential for sockets and mutation APIs during the room lifetime.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** Replay permits participant impersonation and inherits the impact of every operation authorised by the bearer.

Likelihood assessment:
- **Level:** medium
- **Rationale:** medium

#### Remediation

Add an authenticated endpoint that mints a very short-lived, participant- and room-bound socket ticket. Consume it atomically on the first upgrade, never put the rejoin token in a URL, and rotate the rejoin credential after successful reclaim.

Tests:
- Assert WebSocket URLs contain only a one-time ticket.
- Reuse a consumed ticket and expect 401.
- Reclaim twice and verify the old rejoin credential is invalid.

Preventive controls:
- Secret-in-URL static check.
- Purpose-bound credential service.
- Redacted infrastructure logging policy.

<a id="finding-10"></a>

### [10] Narrow read-only clients still start microphone capture and publication

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | The getUserMedia and publication setup path is explicit. Actual narrow-browser relay publication was not reproduced and browser permission remains authoritative. |
| Category | privacy-violation |
| CWE | CWE-359 |
| Affected lines | src/client/pages/RoomPage.tsx:173-241, src/client/styles.css:855-954, src/client/hooks/useRoomSession.ts:80, src/client/session/RoomSession.ts:241-262, src/client/audio/CaptureController.ts:59-72 |

#### Summary

The narrow layout is implemented as labels and CSS-hidden controls, but useRoomSession starts the same full RoomSession. RoomSession.start unconditionally invokes startPublishing, which requests getUserMedia and publishes frames when transport is live.

#### Root Cause

Read-only capability is represented only in responsive presentation; it is not a session policy consumed by capture and publication code.

**Every room session starts publication** — `src/client/session/RoomSession.ts:241-262`

No viewport or read-only policy prevents microphone startup.

```typescript
/**
 * Applies a room snapshot the caller already fetched, starts microphone
 * capture, then opens the control channel and evaluates transport.
 */
async start(room: RoomSnapshot): Promise<void> {
  this.startedAt = this.now();
  this.applyRoom(room);
  this.openControlChannel();
  void this.devices.start();
  void this.runNetworkProbe(room);
  // The room entry action expresses the user's intent to join live audio.
  // Browser permission remains authoritative; denial becomes listen-only.
  void this.startPublishing();
  await this.openTransport();
}
```

**CaptureController requests the microphone** — `src/client/audio/CaptureController.ts:59-72`

Read-only presentation does not stop the privacy-sensitive API call.

```typescript
const support = inspectCaptureSupport();
if (!support.available) throw new Error(support.reason);
this.stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    channelCount: 1,
    sampleRate: CAPTURE_SAMPLE_RATE,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
});
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Every room session starts publication** — `src/client/session/RoomSession.ts:241-262`

No viewport or read-only policy prevents microphone startup.

```typescript
/**
 * Applies a room snapshot the caller already fetched, starts microphone
 * capture, then opens the control channel and evaluates transport.
 */
async start(room: RoomSnapshot): Promise<void> {
  this.startedAt = this.now();
  this.applyRoom(room);
  this.openControlChannel();
  void this.devices.start();
  void this.runNetworkProbe(room);
  // The room entry action expresses the user's intent to join live audio.
  // Browser permission remains authoritative; denial becomes listen-only.
  void this.startPublishing();
  await this.openTransport();
}
```

**CaptureController requests the microphone** — `src/client/audio/CaptureController.ts:59-72`

Read-only presentation does not stop the privacy-sensitive API call.

```typescript
const support = inspectCaptureSupport();
if (!support.available) throw new Error(support.reason);
this.stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    channelCount: 1,
    sampleRate: CAPTURE_SAMPLE_RATE,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
});
```

Assertions:
- Narrow UI says read-only and hides controls.
- RoomSession.start always calls startPublishing.
- CaptureController requests getUserMedia and live sessions publish encoded frames.

Counterevidence and remaining uncertainty:
- The user explicitly joins.
- Browser permission denial produces listen-only.
- Relay transport is trace-unverified and unsupported devices may fail capture.

Limitations:
- A real narrow browser with pre-granted permission was not exercised.

#### Dataflow

The canonical finding records the affected path at src/client/pages/RoomPage.tsx:173-241, src/client/styles.css:855-954, src/client/hooks/useRoomSession.ts:80, src/client/session/RoomSession.ts:241-262, src/client/audio/CaptureController.ts:59-72, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Open or join on a narrow viewport.
- RoomPage renders read-only labels.
- useRoomSession starts RoomSession.
- startPublishing calls getUserMedia.
- If transport is live, publishFrame sends audio objects.

**Every room session starts publication** — `src/client/session/RoomSession.ts:241-262`

No viewport or read-only policy prevents microphone startup.

```typescript
/**
 * Applies a room snapshot the caller already fetched, starts microphone
 * capture, then opens the control channel and evaluates transport.
 */
async start(room: RoomSnapshot): Promise<void> {
  this.startedAt = this.now();
  this.applyRoom(room);
  this.openControlChannel();
  void this.devices.start();
  void this.runNetworkProbe(room);
  // The room entry action expresses the user's intent to join live audio.
  // Browser permission remains authoritative; denial becomes listen-only.
  void this.startPublishing();
  await this.openTransport();
}
```

**CaptureController requests the microphone** — `src/client/audio/CaptureController.ts:59-72`

Read-only presentation does not stop the privacy-sensitive API call.

```typescript
const support = inspectCaptureSupport();
if (!support.available) throw new Error(support.reason);
this.stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    channelCount: 1,
    sampleRate: CAPTURE_SAMPLE_RATE,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
});
```

#### Reachability

A user joins on a narrow screen, sees a read-only room, but the full session still requests and starts microphone capture; live transport then publishes frames.

Preconditions:
- The browser supports capture; publication additionally requires permission and live relay acceptance.

Existing controls:
- The user explicitly joins.
- Browser permission denial produces listen-only.
- Relay transport is trace-unverified and unsupported devices may fail capture.

Limitations:
- A real narrow browser with pre-granted permission was not exercised.

#### Severity

**Medium** — A user told that the room is read-only can have microphone capture begin after joining and, where permission already exists and relay transport succeeds, transmit audio contrary to the product's mobile publishing boundary.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** Unexpected microphone capture and potential transmission violate the stated read-only privacy expectation.

Likelihood assessment:
- **Level:** medium
- **Rationale:** medium

#### Remediation

Determine read-only mode before starting RoomSession, skip getUserMedia and publication entirely, stop capture if the configuration becomes read-only, and require a fresh explicit opt-in before enabling publishing.

Tests:
- On a narrow viewport, assert navigator.mediaDevices.getUserMedia is never called.
- Assert no publication is created in read-only mode.
- Transition into read-only and assert active capture and publication close.
- Require explicit user opt-in before transitioning to publishing mode.

Preventive controls:
- Explicit capability model for publish versus read-only.
- Privacy API tests across viewport/configuration matrix.
- Visible microphone state driven by actual capture state.

<a id="finding-11"></a>

### [11] Playback deduplication retains unbounded object identifiers per group

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The ordering and unbounded nested Set are direct source facts; normal 50-object cadence is not enforced. |
| Category | resource-exhaustion |
| CWE | CWE-770 |
| Affected lines | src/client/session/RoomSession.ts:776-790, src/client/audio/TrackPlayer.ts:72-87, src/client/audio/PlaybackDeduplicator.ts:11-59 |

#### Summary

TrackPlayer records each group/object identifier before validating the audio envelope. PlaybackDeduplicator limits the number of groups to four but places every unique objectId in an uncapped Set, so one constant group grows for the player's lifetime.

#### Root Cause

A group-count limit was mistaken for a total memory bound; per-group cardinality, bytes, cadence and malformed-object budgets are absent.

**One group retains unlimited object IDs** — `src/client/audio/PlaybackDeduplicator.ts:21-37`

The group-count pruning does not bound entries within the Set.

```typescript
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
  objects.add(objectId);
  return true;
}
```

**Identifiers are retained before payload validation** — `src/client/audio/TrackPlayer.ts:72-87`

Malformed objects still consume deduplication memory.

```typescript
accept(groupId: number, objectId: number, payload: Uint8Array, now: number): void {
  if (!this.dedupe.accept(this.participantId, groupId, objectId)) return;
  let decoded: { metadata: AudioFrameMetadata; opusFrame: Uint8Array };
  try {
    decoded = decodeAudioObject(payload);
  } catch (error) {
    this.callbacks.onError?.(this.trackId, error instanceof Error ? error : new Error("Malformed audio object."));
    return;
  }
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**One group retains unlimited object IDs** — `src/client/audio/PlaybackDeduplicator.ts:21-37`

The group-count pruning does not bound entries within the Set.

```typescript
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
  objects.add(objectId);
  return true;
}
```

**Identifiers are retained before payload validation** — `src/client/audio/TrackPlayer.ts:72-87`

Malformed objects still consume deduplication memory.

```typescript
accept(groupId: number, objectId: number, payload: Uint8Array, now: number): void {
  if (!this.dedupe.accept(this.participantId, groupId, objectId)) return;
  let decoded: { metadata: AudioFrameMetadata; opusFrame: Uint8Array };
  try {
    decoded = decodeAudioObject(payload);
  } catch (error) {
    this.callbacks.onError?.(this.trackId, error instanceof Error ? error : new Error("Malformed audio object."));
    return;
  }
}
```

Assertions:
- One Set accepts unlimited unique object IDs.
- A constant group never triggers group pruning.
- Malformed payloads are retained before decode failure.

Counterevidence and remaining uncertainty:
- Closing or forgetting a player clears state.
- Creating more than four groups prunes old groups.
- External stream backpressure may reduce rate but does not cap retained entries.

Limitations:
- A live browser exhaustion threshold was not measured.

#### Dataflow

The canonical finding records the affected path at src/client/session/RoomSession.ts:776-790, src/client/audio/TrackPlayer.ts:72-87, src/client/audio/PlaybackDeduplicator.ts:11-59, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Join as a human publisher.
- Hold groupId constant and vary objectId.
- Send valid or malformed objects at high rate.
- Each subscribed TrackPlayer adds the ID to its Set.

**One group retains unlimited object IDs** — `src/client/audio/PlaybackDeduplicator.ts:21-37`

The group-count pruning does not bound entries within the Set.

```typescript
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
  objects.add(objectId);
  return true;
}
```

**Identifiers are retained before payload validation** — `src/client/audio/TrackPlayer.ts:72-87`

Malformed objects still consume deduplication memory.

```typescript
accept(groupId: number, objectId: number, payload: Uint8Array, now: number): void {
  if (!this.dedupe.accept(this.participantId, groupId, objectId)) return;
  let decoded: { metadata: AudioFrameMetadata; opusFrame: Uint8Array };
  try {
    decoded = decodeAudioObject(payload);
  } catch (error) {
    this.callbacks.onError?.(this.trackId, error instanceof Error ? error : new Error("Malformed audio object."));
    return;
  }
}
```

#### Reachability

A malicious human publishes a high-rate same-group stream on their own track; automatic subscribers retain every new object ID before rejecting or decoding the payload.

Preconditions:
- The relay delivers the publisher's track to human subscribers.

Existing controls:
- Closing or forgetting a player clears state.
- Creating more than four groups prunes old groups.
- External stream backpressure may reduce rate but does not cap retained entries.

Limitations:
- A live browser exhaustion threshold was not measured.

#### Severity

**Medium** — A malicious joined publisher can grow every automatically subscribed browser's heap indefinitely, including with malformed payloads that never reach playback.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** Victim tabs consume unbounded memory until audio/UI failure or termination.

Likelihood assessment:
- **Level:** high
- **Rationale:** high

#### Remediation

Validate the envelope before retaining a dedupe key, cap identifiers per group and per track using expected cadence plus a burst margin, reject implausible progress and quarantine persistently malformed or over-budget tracks.

Tests:
- Feed thousands of unique IDs in one group and assert fixed retained cardinality.
- Repeat with malformed payloads and assert no dedupe growth.
- Exceed the budget and assert track quarantine/unsubscription.

Preventive controls:
- Per-track object and byte budgets.
- Monotonic identifier validation.
- Media-abuse telemetry and quarantine state.

<a id="finding-12"></a>

### [12] Worker parses unbounded JSON bodies before rate limiting or authentication

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The ordering and absence of any declared-length or streaming byte bound are directly visible. |
| Category | resource-exhaustion |
| CWE | CWE-400 |
| Affected lines | src/worker/validation.ts:11-25, src/worker/index.ts:98-102, src/worker/index.ts:146-260 |

#### Summary

readJsonObject calls request.json() after checking only Content-Type. Field validation, the room-creation limiter and participant authentication all occur after the entire attacker-controlled body has been buffered and parsed.

#### Root Cause

The shared JSON helper treats platform request limits as the only byte bound and the route ordering performs cheap admission controls only after parsing.

**Whole body parsed without byte limit** — `src/worker/validation.ts:11-25`

No application body ceiling is checked before the full parse.

```typescript
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected an application/json request.");
  }
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body is not an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Whole body parsed without byte limit** — `src/worker/validation.ts:11-25`

No application body ceiling is checked before the full parse.

```typescript
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected an application/json request.");
  }
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body is not an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}
```

Assertions:
- No Content-Length ceiling, streamed counter or 413 path exists.
- Creation parses before enforceCreationRateLimit.
- Mutation bodies parse before Durable Object credential verification.

Counterevidence and remaining uncertainty:
- Non-JSON Content-Type is rejected.
- Join checks room existence first.
- Cloudflare limits make each request finite; fields are bounded after parsing.

Limitations:
- No runtime memory or CPU threshold was measured.

#### Dataflow

The canonical finding records the affected path at src/worker/validation.ts:11-25, src/worker/index.ts:98-102, src/worker/index.ts:146-260, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Send application/json with a body much larger than the legitimate schema.
- request.json allocates and parses the body.
- Later rate or authentication checks reject only after the cost.

**Whole body parsed without byte limit** — `src/worker/validation.ts:11-25`

No application body ceiling is checked before the full parse.

```typescript
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected an application/json request.");
  }
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body is not an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}
```

#### Reachability

An unauthenticated caller sends oversized JSON to a public or credentialed route; the Worker buffers and parses it before the request is rate-limited or rejected.

Preconditions:
- The request is within any external Cloudflare maximum.

Existing controls:
- Non-JSON Content-Type is rejected.
- Join checks room existence first.
- Cloudflare limits make each request finite; fields are bounded after parsing.

Limitations:
- No runtime memory or CPU threshold was measured.

#### Severity

**Medium** — Unauthenticated or invalid-credential callers can impose disproportionate Worker CPU and memory cost with bodies far larger than the expected sub-kilobyte schemas.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** Repeated requests can consume isolate CPU/memory, increase cost and disrupt room control endpoints.

Likelihood assessment:
- **Level:** high
- **Rationale:** high

#### Remediation

Enforce a small application-specific byte ceiling before JSON.parse using both declared Content-Length and a streaming counter. Run creation rate limiting before reading the body and authenticate mutations before parsing where feasible.

Tests:
- Reject declared bodies above 8 KiB with 413 before parsing.
- Stream a chunked body beyond the cap and assert termination.
- Verify creation limiting runs before body consumption.

Preventive controls:
- Central bounded JSON reader.
- Route-order tests for admission controls.
- Worker CPU and rejected-body-size telemetry without logging payloads.

<a id="finding-13"></a>

### [13] Any participant can spoof another participant's activity

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | The arbitrary target parameter and unrestricted update are explicit, while participant IDs are present in room snapshots. |
| Category | object-authorization |
| CWE | CWE-639 |
| Affected lines | src/worker/index.ts:255-260, src/worker/room.ts:455-464, src/client/room/participantLayout.ts:27-47 |

#### Summary

POST /active accepts a caller-selected targetId. markActive authenticates the caller but updates last_active_at for any matching participant without binding the target to the caller or a verified received track.

#### Root Cause

The activity endpoint trusts a client assertion about who produced audio instead of deriving recency from an authenticated publication or track-observation capability.

**Authenticated caller selects any target** — `src/worker/room.ts:455-464`

Authentication proves only the caller; it does not authorise the caller-selected target.

```typescript
/** Audio object arrival is the source of truth for "connected" (§6.2). */
async markActive(credential: ParticipantCredential, participantId: string): Promise<void> {
  await this.assertParticipant(credential.participantId, credential.rejoinToken);
  if (!this.meta()) return;
  this.ctx.storage.sql.exec(
    "UPDATE participants SET last_active_at = ? WHERE id = ?",
    Date.now(),
    participantId,
  );
}
```

#### Validation

The source-to-sink path and missing control were traced directly; documented mitigations and external uncertainties were considered.

Validation method: Offline source review of the exact authorised Git revision.

- **Status:** validated
- **Disposition:** reported

**Authenticated caller selects any target** — `src/worker/room.ts:455-464`

Authentication proves only the caller; it does not authorise the caller-selected target.

```typescript
/** Audio object arrival is the source of truth for "connected" (§6.2). */
async markActive(credential: ParticipantCredential, participantId: string): Promise<void> {
  await this.assertParticipant(credential.participantId, credential.rejoinToken);
  if (!this.meta()) return;
  this.ctx.storage.sql.exec(
    "UPDATE participants SET last_active_at = ? WHERE id = ?",
    Date.now(),
    participantId,
  );
}
```

Assertions:
- Any valid participant credential passes authentication.
- The target does not need to equal the caller.
- Snapshots reveal valid target IDs and layout uses lastActiveAt.

Counterevidence and remaining uncertainty:
- Unknown IDs cause a no-op.
- No immediate broadcast occurs.
- Local degradation uses locally observed object time.

#### Dataflow

The canonical finding records the affected path at src/worker/index.ts:255-260, src/worker/room.ts:455-464, src/client/room/participantLayout.ts:27-47, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Join the room.
- Read participant IDs from the snapshot.
- POST /active with another participant's targetId.
- Later snapshots reorder or highlight the target as recently active.

**Authenticated caller selects any target** — `src/worker/room.ts:455-464`

Authentication proves only the caller; it does not authorise the caller-selected target.

```typescript
/** Audio object arrival is the source of truth for "connected" (§6.2). */
async markActive(credential: ParticipantCredential, participantId: string): Promise<void> {
  await this.assertParticipant(credential.participantId, credential.rejoinToken);
  if (!this.meta()) return;
  this.ctx.storage.sql.exec(
    "UPDATE participants SET last_active_at = ? WHERE id = ?",
    Date.now(),
    participantId,
  );
}
```

#### Reachability

A joined participant repeatedly calls /active for another known participant ID, updating shared recency without observing audio.

Preconditions:
- The attacker has an active participant credential.

Existing controls:
- Unknown IDs cause a no-op.
- No immediate broadcast occurs.
- Local degradation uses locally observed object time.

#### Severity

**Low** — A joined attendee can falsify audience-visible recency and participant ordering. The impact is limited to presentation integrity and does not directly change media routing or local degradation state.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** low
- **Rationale:** Audience-facing activity indicators can be manipulated, undermining demonstration integrity.

Likelihood assessment:
- **Level:** high
- **Rationale:** high

#### Remediation

Remove the public arbitrary-target mutation. Derive activity from authenticated publication events, or require a capability proving the caller observed an authorised target track, and rate-limit reports.

Tests:
- Assert callers cannot update another participant's recency.
- Verify recency updates are tied to authenticated publication or authorised observation.
- Rate-limit repeated activity reports.

Preventive controls:
- Object-level authorisation for target mutations.
- Server-derived activity when the transport supports it.
- Cross-participant negative tests.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Independent baseline security audit | Repository-wide baseline review | Reported | Reviewed 47 of 93 authorised files and returned six pending candidates; no separate receipt file was created. All returned candidates were source-validated, merged where duplicated, and closed as reported or rejected. |
| Media and request-resource boundary investigation | Untrusted relay objects, browser media buffers, relay authorisation and Worker body parsing | Reported | Focused source review returned four pending candidates; captured before parent merge or validation. All returned candidates were source-validated, merged where duplicated, and closed as reported or rejected. |
| Control-plane authorisation and abuse-boundary investigation | Relay credentials, presenter and AI authority, routing privacy, WebSocket and Durable Object resource boundaries | Reported | Focused source review returned eleven pending candidates; captured before parent merge, deduplication or validation. All returned candidates were source-validated, merged where duplicated, and closed as reported or rejected. |
| Remaining authorised inventory review | Previously uncovered client UI, capture, tests, documentation, generated types, lockfile and design assets | Reported | Completed review of the outstanding inventory. Returned eight pending candidates, mostly independent corroboration of existing control/media candidates, plus one narrow read-only capture candidate. All returned candidates were source-validated, merged where duplicated, and closed as reported or rejected. |
| Validated finding: Room creation and joining disclose a relay-wide publish/subscribe bearer | broken-access-control | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: baseline-relay-wide-credential, media-relay-wide-credential, control-relay-credential-create, control-relay-credential-join. |
| Validated finding: Any joined human can execute presenter and AI lifecycle controls | missing-authorization | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: baseline-presenter-global-controls, control-presenter-simulation-authorisation, control-ai-lifecycle-authorisation, remaining-ai-creation-authorisation, remaining-ai-removal-authorisation, remaining-ai-pipeline-authorisation, remaining-presenter-client-only, remaining-ai-to-ai-authorisation. |
| Validated finding: Unvalidated AI identifiers can wedge or pre-empt the global floor | improper-input-validation | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: control-floor-target-validation. |
| Validated finding: Public room snapshots disclose every human's per-AI routing preferences | sensitive-data-exposure | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: control-routing-row-disclosure. |
| Validated finding: A reusable participant bearer is placed in the WebSocket query string | credential-exposure | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: baseline-websocket-query-token, control-websocket-query-token. |
| Validated finding: One participant token can open unbounded concurrent control sockets | resource-exhaustion | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: control-concurrent-websockets. |
| Validated finding: Unthrottled open-room joins permit unbounded participant and routing allocation | resource-exhaustion | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: control-unthrottled-joins, baseline-join-websocket-resource-limits. |
| Validated finding: Worker parses unbounded JSON bodies before rate limiting or authentication | resource-exhaustion | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: baseline-unbounded-json-body, media-unbounded-json-body. |
| Validated finding: Playback deduplication retains unbounded object identifiers per group | resource-exhaustion | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: media-unbounded-playback-deduplication, remaining-playback-deduplication. |
| Validated finding: Media bursts trigger count-unbounded sorting and decoder submission | algorithmic-complexity | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: media-jitter-decoder-burst, remaining-jitter-cardinality, baseline-inbound-media-budget. |
| Validated finding: Unknown room-code probes initialise persistent SQLite Durable Objects | resource-exhaustion | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: control-arbitrary-room-do-initialisation. |
| Validated finding: Narrow read-only clients still start microphone capture and publication | privacy-violation | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: remaining-narrow-capture. |
| Validated finding: Any participant can spoof another participant's activity | object-authorization | Reported | Validated by source trace at revision a784122aa18c6b7fbee1ae53d34b054a24d71f0b; merged candidate IDs: control-activity-target-spoofing. |
| Merged duplicate candidate: Inbound media objects have no per-track object-count or byte budget | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as resource-exhaustion.unbounded-playback-dedupe, resource-exhaustion.media-burst-sorting. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Time-window pruning does not bound jitter-buffer burst cardinality | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as resource-exhaustion.media-burst-sorting. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Playback deduplication is unbounded within a single object group | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as resource-exhaustion.unbounded-playback-dedupe. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Worker parses unbounded JSON bodies before rate limiting or participant authentication | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as resource-exhaustion.unbounded-json-body. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Room joins and control WebSockets have no per-room or per-credential resource limits | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as resource-exhaustion.concurrent-control-sockets, resource-exhaustion.unthrottled-open-joins. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: A reusable participant bearer is placed in the WebSocket query string instead of a single-use socket ticket | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as credential-exposure.websocket-query-bearer. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Any joined human can perform presenter-only simulation and AI-to-AI safety mutations | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as authorization.any-human-global-room-control. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Any joined human can create, remove or falsify global AI state | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as authorization.any-human-global-room-control. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Any joined human can create unbounded room-wide AI participants | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as authorization.any-human-global-room-control. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Any joined human can remove any AI from the room | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as authorization.any-human-global-room-control. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Any joined human can falsify any AI pipeline state | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as authorization.any-human-global-room-control. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Client-only presenter mode does not protect presenter simulation controls | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as authorization.any-human-global-room-control. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Any joined human can enable or disable room-wide AI-to-AI exchange | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as authorization.any-human-global-room-control. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: A static relay-wide credential is returned to every participant without room, publisher or subscription scope | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as access-control.relay-wide-browser-bearer. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Unauthenticated room creation discloses a Worker-wide relay publish/subscribe bearer | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as access-control.relay-wide-browser-bearer. Its evidence remains represented by the validated finding locations and this closure surface. |
| Merged duplicate candidate: Open-room joining independently discloses the same relay-wide bearer without an issuance throttle | Duplicate candidate reconciliation | Rejected | Rejected as a separate finding after source validation because it describes the same broken control, attack path and effective remediation as access-control.relay-wide-browser-bearer. Its evidence remains represented by the validated finding locations and this closure surface. |
