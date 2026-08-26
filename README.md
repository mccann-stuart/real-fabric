# Real Fabric

> People and AIs speaking over Media over QUIC.

Real Fabric is a conference-stage demonstration of humans and AI agents speaking over independent Media over QUIC tracks while an inspector shows relay fan-out, subscriptions, routing changes and failure states.

## Status

The room service, presenter simulation, client media pipeline, protocol inspector, provisioned relay-credential handling, network probe and Milestone 2 audio resilience are implemented. The Objects and Latency inspector tabs compare exposed session measurements with the specification's budgets or targets, while diagnostic-only values are labelled `Reported · no gate`. The production Worker is configured with the isolated `real-fabric-production` relay and a short-lived publish/subscribe token. The demo is **not transport-accepted**: Gate 1, a live AI pipeline, measured capacity, acoustic loopback, the audible ten-minute run and two clean venue-network runs remain open.

### Known security issue — shared relay credential disclosure (P1)

Unauthenticated room creation and open room joining currently return the configured `MOQ_RELAY_TOKEN` to the browser. That token grants publish and subscribe operations across the whole configured relay, so a caller can reuse it outside the room service, publish outside its participant namespace, subscribe outside application routing choices or access another room on the same relay until the token expires or is revoked. Keeping the token out of share links, storage, telemetry and logs does not reduce that authority.

Cloudflare's current [MoQ token API](https://developers.cloudflare.com/api/resources/moq/subresources/relays/subresources/tokens/methods/create/) does not present a compatible complete fix. Its V1 tokens apply to an entire relay and constrain only `publish` and `subscribe`; labels are metadata, not room, namespace, track or participant enforcement, and a relay accepts at most ten registered tokens. Unique short-lived per-client tokens would improve expiry and revocation but would not close cross-room or participant-namespace reuse, while the ten-token limit conflicts with Real Fabric's open-membership invariant. A distinct relay per room would isolate rooms but still would not enforce participant namespaces.

This P1 is therefore a known unresolved issue, not an accepted production risk or a completed Gate 1 control. The code is intentionally unchanged pending a relay credential model that can enforce room and participant scope without imposing a participant cap. Do not use the current shared-relay path for sensitive audio, claim tenant isolation or label cooperative routing as relay-enforced.

Milestones 1 and 2 of the §11 release plan are built. Milestones 3 and 4 are not.

**The build attempts a real MOQT session when the relay and its provisioned credential are configured, and still claims nothing it has not traced.** Those are separate facts, and the code keeps them separate:

- **Attempting** is gated on a relay endpoint, a Cloudflare-provisioned publish-and-subscribe token, and a draft the pinned client can frame. `moqtail@0.12.1` frames `moqt-16`, so the build is pinned there (§11.2). A missing token is a named blocking state and produces no WebTransport attempt.
- **Claiming** is gated on `MOQT_TRANSPORT_VERIFIED`, which stays `false` until a browser-to-relay trace is recorded. When a live attempt is possible, the inspector reads "attempted live but not yet claimed as verified"; when configuration blocks it, the inspector says so. The negotiated draft reads **Not exposed** until a SERVER_SETUP has actually been validated.

Conflating the two would have meant never attempting the connection that produces the trace. There is still no second transport to fall back to, and presenter simulation never stands in for a working relay or AI pipeline.

**Draft configuration change, not a rewrite.** `DRAFT_REGISTRY` in [`MoqTransportAdapter`](src/client/transport/MoqTransportAdapter.ts) already carries `moqt-14`, `moqt-16`, `moqt-18` and `moqt-20`, each with the reason it is or is not currently usable. For draft 20 the remaining steps are therefore only to bump `moqtail` to a version that frames it and to repoint `MOQT_DRAFT` and `MOQ_RELAY_URL`; a draft outside that registry needs one entry added first. No room, UI or audio-pipeline code changes.

### H1–H16

| ID | Where it lives | Verified by |
|---|---|---|
| H1 — MOQT over WebTransport only, no fallback | [`MoqTransportAdapter`](src/client/transport/MoqTransportAdapter.ts) is the sole transport and the only module holding draft constants; [`RoomSession`](src/client/session/RoomSession.ts) imports no alternative | `test/milestone-1-transport.test.ts` asserts the draft registry refuses an unframeable draft by name without downgrading. **A live browser-to-relay trace is still outstanding.** |
| H2 — one track per participant, no upstream mixing | [`tracks.ts`](src/shared/tracks.ts), [`mixer-worklet.js`](public/audio/mixer-worklet.js) — the only mixing point, on the listener's machine | `test/invariants.test.ts` |
| H3 — supported browser matrix, others warned | [`pinnedConfiguration.ts`](src/shared/pinnedConfiguration.ts), [`PinnedConfigBanner`](src/client/components/PinnedConfigBanner.tsx), [`UniversalAudioCaptureAdapter`](src/client/audio/UniversalAudioCaptureAdapter.ts) | Configuration detection, capture-path selection and exact frame assembly are unit-tested. Provisional Chrome 141+ on macOS and top-level Safari 27+ on iPhone with iOS 27+ are recognised; real-browser acceptance is still outstanding. |
| H4 — headphones required and stated | Entry page, pre-flight page and room top bar | Visual |
| H5 — each AI addressed, silent otherwise | [`AiDirector.address`](src/client/ai/AiDirector.ts) is the only path to a turn | `test/invariants.test.ts`, `test/room-service.test.ts` |
| H6 — barge-in inside 300 ms, including in flight | `AiDirector.bargeIn`, [`AdaptiveJitterBuffer.cancelGroup`](src/client/audio/AdaptiveJitterBuffer.ts), `TrackPlayer.cancelGroup` | `test/invariants.test.ts` measures the latency and the discarded objects |
| H7 — no cap, visible degradation | [`DegradationLadder`](src/client/audio/DegradationLadder.ts); the room service never refuses a join | `test/invariants.test.ts`, `test/room-service.test.ts`. **Measured capacity figures are outstanding — see below.** |
| H8 — any composition with ≥1 human | `evaluateComposition` in [`contracts.ts`](src/shared/contracts.ts) | `test/room-service.test.ts` |
| H9 — per-AI routing, honestly labelled | Room service `routing` table, [`ParticipantCard`](src/client/components/ParticipantCard.tsx), [`SubscriptionGraph`](src/client/components/SubscriptionGraph.tsx); every real remote card also exposes this listener's actual subscribe/unsubscribe intent and accepted state | `test/invariants.test.ts`, `test/room-service.test.ts`, `test/milestone-1-transport.test.ts` |
| H10 — no AI-to-AI by default | Off by default with a hard turn cap and a visible counter | `test/invariants.test.ts`, `test/room-service.test.ts` |
| H11 — presenter mode runs solo | Configurable simulated counts, reconciled server-side, labelled everywhere | `test/room-service.test.ts` |
| H12 — 60-second reclaim, no duplicate playback | [`useRoomSession`](src/client/hooks/useRoomSession.ts) spends the token on mount; [`PlaybackDeduplicator`](src/client/audio/PlaybackDeduplicator.ts) refuses repeats | `test/invariants.test.ts`, `test/room-service.test.ts` |
| H13 — ten minutes, no drift artefact, no unbounded buffers | [`DriftEstimator`](src/client/audio/DriftEstimator.ts), bounded jitter buffer, [`PacketLossConcealer`](src/client/audio/PacketLossConcealer.ts) and the silence-gated rebuild in [`TrackPlayer`](src/client/audio/TrackPlayer.ts) | `test/invariants.test.ts` runs 30,000 frames; `test/milestone-2-audio.test.ts` covers concealment, the 5% drift threshold and the deferred rebuild. **The live ten-minute run is outstanding.** |
| H14 — every §10 failure distinct and non-silent | [`failures.ts`](src/shared/failures.ts) registry, [`FailureBanner`](src/client/components/FailureBanner.tsx) and [`NetworkProbe`](src/client/transport/NetworkProbe.ts) | Registry and probe logic are tested. The production endpoint is configured; a browser-run direct probe remains outstanding. |
| H15 — unobservable reads **Not exposed** | [`Measurement<T>`](src/shared/measurement.ts) and [`MeasurementValue`](src/client/components/MeasurementValue.tsx); no figure bypasses it | `test/invariants.test.ts` |
| H16 — §12 script twice clean | [`DemoScript`](src/client/presenter/DemoScript.ts) runner with per-cue pass/fail and a two-clean-run gate | `test/invariants.test.ts`. **The venue-network runs are outstanding.** |

### Currently recognised configuration (H3 gap)

The admitted candidates are **Google Chrome 141 or later on macOS** and **top-level Safari 27 or later on iPhone with iOS 27 or later**. Safari 27.x and iOS 27 are currently beta releases and form the initial iPhone acceptance target; later Safari/iOS majors may run capability pre-flight but remain explicitly unverified. Alternative iOS browsers, embedded web views and installed Home Screen mode remain read-only.

Both are **provisional configurations**, not completion of H3. iPhone audio is foreground-only: room membership completes first, then **Start audio** begins capture and transport from the user's tap. Backgrounding, locking or an audio interruption tears down audio and requires an explicit **Resume audio** tap. There is no automatic microphone restart and no fallback transport.

### Measured capacity (H7, §9.2)

**Not yet measured.** H7 forbids a participant cap and makes measured capacity a deliverable, so this section stays empty rather than carrying an estimate:

- participant count at which degradation step one engages: *not measured*
- participant count at which step three engages: *not measured*
- reference hardware and network: *not defined*

The ladder is implemented and unit-tested, and it announces every step. Its current synthetic strain trigger includes more than eight active speakers, a worst buffer of at least 180 ms, or more than three underruns in an evaluation window. Those are implementation triggers, not measured capacity claims. Reference-hardware measurements still need Gate 2.

### Milestone 1 — live transport and relay interoperability (§11.2)

| Deliverable | State |
|---|---|
| Relay endpoint integration on draft 16 | Built. `DRAFT_REGISTRY` holds `moqt-14`, `moqt-16`, `moqt-18` and `moqt-20`, and the adapter refuses by name any entry the pinned `moqtail` cannot frame, as well as any future library that would offer more than the single requested version. It permits `moqtail` to add its pinned `SUPPORTED_VERSIONS` exactly once. This prevents Chrome rejecting duplicate WebTransport protocols and prevents an unrequested draft from being negotiated. |
| CLIENT_SETUP / SERVER_SETUP negotiation | Built. Cloudflare draft-16 authentication places its provisioned token in the WebTransport URL path; the adapter constructs that URL in memory and redacts it from errors and inspection. A session with no SERVER_SETUP, or a `MAX_REQUEST_ID` of zero, is closed as a non-retryable protocol failure rather than left to present as dead air. |
| Publication and subscription request lifecycle | Built. Draft-16 publication sends `PUBLISH` directly and waits for `PUBLISH_OK` before showing an uplink or publish event. Every other permitted real-party track is interested by default: namespace-pushed `PUBLISH` requests receive `PUBLISH_OK` and enter the ordinary player path, while an explicit local opt-out receives `UNINTERESTED`. A publication refusal stops capture and retains its exact code and reason in same-tab inspector history. Missing remote tracks use capped exponential retries, wake immediately on a namespace publication announcement or accepted push, and expose listener-owned subscribe/unsubscribe controls. |
| Pre-flight HTTP/3 and UDP probe | Built, in [`NetworkProbe`](src/client/transport/NetworkProbe.ts). Non-blocking, runs alongside the join, and compares a QUIC leg against a TCP leg to separate filtered UDP from a dead connection. It says so when the two are indistinguishable. |
| Bounded session recovery | Built. Full jitter across the whole backoff window (equal jitter re-synchronises a roomful of clients), 30-second terminal threshold, and a floor so an unlucky draw is not a tight retry loop. |
| **Gate 1 exit: `MOQT_TRANSPORT_VERIFIED = true`** | **Outstanding.** Needs a browser-to-relay trace on a real network. |

**Observed during development:** On 25 August 2026, Chrome reached `draft-16.cloudflare.mediaoverquic.com` over HTTP/3 and completed MOQT draft-16 `SERVER_SETUP`. The earlier `MOQ_DISCOVERY=unknown` path selected the control channel without testing `SUBSCRIBE_NAMESPACE`; it therefore did not record that endpoint capability. Unknown discovery now performs the live request and records its result in the inspector. This remains draft-16 evidence only and cannot satisfy the draft-20 Gate 1 exit.

### Milestone 2 — hardware resilience and audio pipeline (§11.3)

| Deliverable | State |
|---|---|
| Graceful hardware fallback | Built. Room entry starts `startPublishing` automatically; a denied, missing or unsupported microphone enters a named listen-only mode with subscriptions, mixer and inspector untouched, and offers a retry where it gives the reason. |
| Dynamic device tracking | Built, in [`DeviceWatcher`](src/client/audio/DeviceWatcher.ts). A headset plugged in after a listen-only join clears the failure and offers calibration. Device labels are never read, so they cannot reach telemetry (AC-14). |
| Adaptive jitter buffer and Opus PLC | Built. The buffer was already bounded 40–200 ms; concealment was not. [`PacketLossConcealer`](src/client/audio/PacketLossConcealer.ts) fills a sequence gap by repeating the last pitch period with decay, and switches to comfort noise at the track's own noise floor once loss is sustained. Both are counted and shown. |
| Drift estimation and silence rebuilding | Built. The threshold now matches §10.6 (5%, previously 2%), correction is applied at most 2% per step so it stays inaudible, and a rebuild waits for a pause instead of firing mid-word — bounded at 10 seconds so a continuous speaker cannot defer it forever. |
| **Gate 2 exit: ten-minute run and acoustic loopback latency** | **Outstanding.** Both need the reference composition on reference hardware. |

### Gate outcomes still open

These are read from Worker configuration rather than assumed, so recording a result is a configuration change, not a code change:

| Variable | Current | Meaning |
|---|---|---|
| `MOQT_TRANSPORT_VERIFIED` | `false` | No browser-to-relay trace has passed. Gates the *claim*, not the *attempt*: the build connects for real and reports the result honestly either way. |
| `MOQ_ROUTING_ENFORCEMENT` | `cooperative` | The current Cloudflare token grants relay-level publish and subscribe operations rather than per-participant track scope, so inbound routing is labelled cooperative, not enforced (FR8). |
| `MOQ_DISCOVERY` | `unknown` | The client probes `SUBSCRIBE_NAMESPACE` after live MOQT setup, records the observed result in the inspector, and uses control-channel discovery only if the request is refused (FR7). |
| `MOQ_RELAY_TOKEN` | configured · known P1 | Cloudflare-provisioned publish-and-subscribe token stored as a Worker secret. Create and join responses currently disclose it to browsers, and Cloudflare V1 cannot restrict it to one room or participant. The current operational token expires at `2026-09-01T20:38:32Z`; rotation limits lifetime but does not fix the scope issue. |

The production relay is `real-fabric-production` (`5266d64d9209fb9a8961f009745806ef`) with upstream fallback disabled. The endpoint remains `https://draft-16.cloudflare.mediaoverquic.com`; the relay token selects the isolated scope. `/api/health` confirms that endpoint and credential are configured while `transportVerified` remains `false`. The in-room browser probe and token-backed MOQT trace remain outstanding.

## Product invariants

- Every human and AI publishes one independent audio track; the relay never mixes audio.
- Membership is open, with at least one human required and no configured participant cap.
- Each AI speaks only when addressed and does not subscribe to other AIs by default.
- Each human independently controls whether each AI hears them and whether they hear that AI.
- Barge-in must silence the addressed AI audibly within 300 ms.
- Reload within 60 seconds must reclaim identity and routing without duplicate playback.
- Unobservable measurements display **Not exposed**, never zero.
- No audio or transcript content is retained.

## Layout

- `Standards.md` — current browser/API requirements, compatibility matrix and acceptance evidence.
- `src/shared` — contracts, the draft list, the §10 failure registry, `Measurement<T>`, track addressing, the §9.3 latency budget and the pinned configuration.
- `src/client/transport` — `MoqTransportAdapter` (the only module holding draft constants, wire versions or ALPN identifiers) and the draft-free HTTP/3 reachability probe.
- `src/client/session` — `RoomSession`, the bounded reconnection policy and the inspector event log.
- `src/client/audio` — bounded capture adapters and Opus encode, per-track receive path, adaptive jitter buffer, packet loss concealment, drift estimation, device tracking, degradation ladder, playback deduplication and the mixer graph.
- `public/audio/capture-worklet.js` — the same-origin AudioWorklet capture path, with a fixed transferable-buffer pool and exact 20 ms frames.
- `src/client/ai` — the addressing, floor-control and barge-in state machine, plus the labelled scripted responder.
- `src/client/presenter` — the §12 demo-script runner.
- `src/client/components`, `src/client/pages` — entry, pre-flight, room, inspector and presenter surfaces.
- `public/audio/mixer-worklet.js` — the single mixing point, served same-origin so it satisfies the existing `script-src 'self'` policy.
- `src/worker` — API routing, security headers, redacted structured logs, provisioned relay credential handling and the SQLite Durable Object room service.
- `test` — 206 automated tests across seventeen files covering the requirements above.

## Local setup

The canonical checkout and Git metadata are stored in OneDrive, while linked Codex worktrees may live elsewhere. In every checkout or worktree, the physical dependency tree must remain outside OneDrive at `/Users/mccannstuart/.node_modules`, with the repository path symlinked to it:

```sh
test -L node_modules && test "$(readlink node_modules)" = "/Users/mccannstuart/.node_modules"
```

If `/Users/mccannstuart/.node_modules` already exists but the repository link is absent, recreate only the link:

```sh
ln -s /Users/mccannstuart/.node_modules node_modules
```

```sh
pnpm install --frozen-lockfile --modules-dir /Users/mccannstuart/.node_modules
```

Use the pinned pnpm 11.22.0 from `package.json` and always pass the explicit external `--modules-dir` shown above. Plain `pnpm install` refuses to reify a symlink target outside the project root. Never run `npm install`: npm 11 removes a symlinked top-level `node_modules` and would put dependency churn back under OneDrive.

After installation, verify both the link text and resolved target before running package scripts:

```sh
test "$(readlink node_modules)" = "/Users/mccannstuart/.node_modules"
test "$(realpath node_modules)" = "/Users/mccannstuart/.node_modules"
```

## Development commands

```sh
pnpm dev
```

Run the full check set with:

```sh
pnpm check
```

That is `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm deploy:dry-run`.

Cloudflare Workers Builds sets `WORKERS_CI=1` during dependency installation.
The guarded `postinstall` hook builds `dist/` in that environment because Workers
Builds does not run Wrangler custom-build configuration before its default
`npx wrangler deploy` command. The hook exits without building during local
dependency installs.

## What is not verified

Automated checks cover the requirements marked above. They do not cover, and this repository does not claim:

- MOQT interoperability, or that any audio has moved over the configured relay. The pinned client frames draft 16 and the production credential is present, but the handshake path still has only unit-test evidence;
- a live UDP/HTTP-3 network-probe result;
- relay acceptance and expiry behaviour for the provisioned credential, or relay-level enforcement beyond coarse publish/subscribe operations;
- room, namespace, track or participant enforcement for the relay credential; the current shared-token disclosure is the known P1 described above;
- audible quality of the packet loss concealment. Its behaviour is unit-tested; nobody has listened to it;
- a live recognition, model or speech-synthesis pipeline;
- publication of the barge-in cancellation marker over MOQT;
- the §9.3 latency budget, which needs the §9.4 acoustic loopback method;
- measured capacity;
- the ten-minute reference-composition run (H13);
- milestones 3 and 4 of the §11 release plan, which are not built;
- the §12 script on a venue network (H16);
- physical-device Safari 27 behaviour and browser behaviour beyond the two provisional configurations, including the complete supported-browser acceptance matrix required by H3;
- real-browser and acoustic parity of the AudioWorklet capture path against `MediaStreamTrackProcessor`.

Production deployment requires separate, explicit authorisation. A successful local build or GitHub push is not a production deployment.
