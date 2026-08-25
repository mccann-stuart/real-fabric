# Real Fabric

> People and AIs speaking over Media over QUIC.

Real Fabric is a conference-stage demonstration of humans and AI agents speaking over independent Media over QUIC tracks while an inspector shows relay fan-out, subscriptions, routing changes and failure states.

## Status

Every hard requirement H1–H16 in [PRODUCT_SPEC_v1-demo_1.md](PRODUCT_SPEC_v1-demo_1.md) §0.1 is implemented, except where a live `draft-20` relay is the only way to observe it. The table below states exactly which half each one is in.

**Live transport remains blocked, and nothing in the build pretends otherwise.** No relay endpoint serves the pinned MOQT draft, so the room service mints no relay credential, the client reports the specific "no draft-20 relay endpoint" failure at startup rather than at join, and there is no second transport to fall back to. Presenter simulation demonstrates the room; it never stands in for a working relay or AI pipeline.

### H1–H16

| ID | Where it lives | Verified by |
|---|---|---|
| H1 — MOQT over WebTransport only, no fallback | [`MoqTransportAdapter`](src/client/transport/MoqTransportAdapter.ts) is the sole transport; [`RoomSession`](src/client/session/RoomSession.ts) imports no alternative | `test/room-service.test.ts` asserts the draft failure and null credential. **A live browser-to-relay trace is still outstanding.** |
| H2 — one track per participant, no upstream mixing | [`tracks.ts`](src/shared/tracks.ts), [`mixer-worklet.js`](public/audio/mixer-worklet.js) — the only mixing point, on the listener's machine | `test/invariants.test.ts` |
| H3 — one pinned browser, others warned | [`pinnedConfiguration.ts`](src/shared/pinnedConfiguration.ts), [`PinnedConfigBanner`](src/client/components/PinnedConfigBanner.tsx) | `test/invariants.test.ts` |
| H4 — headphones required and stated | Entry page, pre-flight page and room top bar | Visual |
| H5 — each AI addressed, silent otherwise | [`AiDirector.address`](src/client/ai/AiDirector.ts) is the only path to a turn | `test/invariants.test.ts`, `test/room-service.test.ts` |
| H6 — barge-in inside 300 ms, including in flight | `AiDirector.bargeIn`, [`AdaptiveJitterBuffer.cancelGroup`](src/client/audio/AdaptiveJitterBuffer.ts), `TrackPlayer.cancelGroup` | `test/invariants.test.ts` measures the latency and the discarded objects |
| H7 — no cap, visible degradation | [`DegradationLadder`](src/client/audio/DegradationLadder.ts); the room service never refuses a join | `test/invariants.test.ts`, `test/room-service.test.ts`. **Measured capacity figures are outstanding — see below.** |
| H8 — any composition with ≥1 human | `evaluateComposition` in [`contracts.ts`](src/shared/contracts.ts) | `test/room-service.test.ts` |
| H9 — per-AI routing, honestly labelled | Room service `routing` table, [`ParticipantCard`](src/client/components/ParticipantCard.tsx), [`SubscriptionGraph`](src/client/components/SubscriptionGraph.tsx) | `test/invariants.test.ts`, `test/room-service.test.ts` |
| H10 — no AI-to-AI by default | Off by default with a hard turn cap and a visible counter | `test/invariants.test.ts`, `test/room-service.test.ts` |
| H11 — presenter mode runs solo | Configurable simulated counts, reconciled server-side, labelled everywhere | `test/room-service.test.ts` |
| H12 — 60-second reclaim, no duplicate playback | [`useRoomSession`](src/client/hooks/useRoomSession.ts) spends the token on mount; [`PlaybackDeduplicator`](src/client/audio/PlaybackDeduplicator.ts) refuses repeats | `test/invariants.test.ts`, `test/room-service.test.ts` |
| H13 — ten minutes, no drift artefact, no unbounded buffers | [`DriftEstimator`](src/client/audio/DriftEstimator.ts), bounded jitter buffer | `test/invariants.test.ts` runs 30,000 frames. **The live ten-minute run is outstanding.** |
| H14 — every §10 failure distinct and non-silent | [`failures.ts`](src/shared/failures.ts) registry and [`FailureBanner`](src/client/components/FailureBanner.tsx) | `test/invariants.test.ts` |
| H15 — unobservable reads **Not exposed** | [`Measurement<T>`](src/shared/measurement.ts) and [`MeasurementValue`](src/client/components/MeasurementValue.tsx); no figure bypasses it | `test/invariants.test.ts` |
| H16 — §12 script twice clean | [`DemoScript`](src/client/presenter/DemoScript.ts) runner with per-cue pass/fail and a two-clean-run gate | `test/invariants.test.ts`. **The venue-network runs are outstanding.** |

### Tested configuration (H3)

**Google Chrome 141 or later on macOS.** Any other browser, platform or major version shows a "not the tested configuration" banner and its behaviour is unverified.

This pin is **provisional**: specification §14 assigns the final browser, operating system and major version at Gate 2 exit. The detection mechanism is complete either way; only the declared target moves.

### Measured capacity (H7, §9.2)

**Not yet measured.** H7 forbids a participant cap and makes measured capacity a deliverable, so this section stays empty rather than carrying an estimate:

- participant count at which degradation step one engages: *not measured*
- participant count at which step three engages: *not measured*
- reference hardware and network: *not defined*

The ladder is implemented and unit-tested, and it announces every step. What is missing is the measurement on reference hardware, which needs Gate 2.

### Gate 1 outcomes still open

These are read from Worker configuration rather than assumed, so recording a Gate 1 result is a configuration change, not a code change:

| Variable | Current | Meaning |
|---|---|---|
| `MOQT_TRANSPORT_VERIFIED` | `false` | No browser-to-relay trace has passed. Blocks live audio; blocks nothing else. |
| `MOQ_ROUTING_ENFORCEMENT` | `cooperative` | Per-track credential scoping is unproven, so inbound routing is labelled cooperative, not enforced (FR8). |
| `MOQ_DISCOVERY` | `unknown` | `SUBSCRIBE_NAMESPACE` support on the endpoint is untested, so the inspector says discovery is undetermined (FR7). |

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

- `src/shared` — contracts, the §10 failure registry, `Measurement<T>`, track addressing, the §9.3 latency budget and the pinned configuration.
- `src/client/session` — `RoomSession`, the bounded reconnection policy and the inspector event log.
- `src/client/audio` — capture and Opus encode, per-track receive path, adaptive jitter buffer, drift estimation, degradation ladder, playback deduplication and the mixer graph.
- `src/client/ai` — the addressing, floor-control and barge-in state machine, plus the labelled scripted responder.
- `src/client/presenter` — the §12 demo-script runner.
- `src/client/components`, `src/client/pages` — entry, pre-flight, room, inspector and presenter surfaces.
- `public/audio/mixer-worklet.js` — the single mixing point, served same-origin so it satisfies the existing `script-src 'self'` policy.
- `src/worker` — API routing, security headers, redacted structured logs and the SQLite Durable Object room service.
- `test` — 76 tests covering the requirements above.

## Local setup

This checkout is stored in OneDrive. Its physical dependency tree must remain outside OneDrive at `/Users/mccannstuart/.node_modules`, with the repository path symlinked to it:

```sh
test -L node_modules && test "$(readlink node_modules)" = "/Users/mccannstuart/.node_modules"
```

```sh
pnpm install --frozen-lockfile --modules-dir /Users/mccannstuart/.node_modules
```

Use the pinned pnpm 11.22.0 from `package.json` and always pass the explicit external `--modules-dir` shown above. Plain `pnpm install` refuses to reify a symlink target outside the project root. Never run `npm install`: npm 11 removes a symlinked top-level `node_modules` and would put dependency churn back under OneDrive.

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

- MOQT interoperability, or that any audio has moved over a relay;
- the §9.3 latency budget, which needs the §9.4 acoustic loopback method;
- measured capacity;
- the ten-minute reference-composition run (H13);
- the §12 script on a venue network (H16);
- browser behaviour on any configuration other than the provisional pin.

Production deployment requires separate, explicit authorisation. A successful local build or GitHub push is not a production deployment.
