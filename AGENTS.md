# Real Fabric repository instructions

These instructions apply to the entire repository.

## Mission

Build Real Fabric: a conference-stage demonstration in which humans and AI agents speak through independent Media over QUIC tracks while the audience can inspect the transport, relay fan-out, routing changes and failure states.

Optimise for a reliable ten-minute live demonstration, not for a general-purpose conferencing service.

Use UK English in user-facing prose and documentation.

## Sources of truth

1. The current user request.
2. This file.
3. `PRODUCT_SPEC_v1-demo_1.md`.
4. Existing repository conventions and tests.

The product specification is binding except for this explicit override:

- Do not block implementation on publication or relay availability for MOQT draft 20. It is expected to become available during the build.
- Keep all MOQT-version-specific code behind `MoqTransportAdapter` so draft 20 can be inserted or updated without changing room semantics, UI state or audio-pipeline code.
- Do not silently downgrade live audio to another MOQT draft or another transport.
- Do not claim that transport works until a browser-to-relay trace verifies it. Before then, show a specific “relay unavailable” or “draft unavailable” state.
- Draft availability may block transport acceptance testing, but it must not block the frontend, room service, presenter simulation, media pipeline, inspector, telemetry or automated tests.

If this file and the product specification otherwise conflict, preserve the hard product requirements and ask only when the choice would materially change user-visible behaviour, security or data handling.

## Current implementation truth

As reconciled on 25 August 2026 with the current repository state:

- The React/Vite client, SQLite Durable Object room service, control-plane WebSocket, presenter simulation, browser media components, inspector, telemetry and failure registry are implemented with 118 automated tests across nine files.
- `wrangler.jsonc` pins MOQT draft 16, configures the Cloudflare isolated relay URL, and deliberately keeps `MOQT_TRANSPORT_VERIFIED=false`, `MOQ_ROUTING_ENFORCEMENT=cooperative` and `MOQ_DISCOVERY=unknown`.
- `moqtail@0.12.1` frames draft 16. `MoqTransportAdapter` attempts draft-16 transport with provisioned token in URL path, but live transport is not yet trace-verified (`MOQT_TRANSPORT_VERIFIED=false`).
- Provisioned relay-token handling is implemented. The room service returns the configured `MOQ_RELAY_TOKEN` at join; relay acceptance, enforcement and expiry remain unverified.
- `NetworkProbe` implements a draft-free relay reachability check alongside `/api/health`.
- Dynamic device tracking, packet-loss concealment, bounded recovery and silence-gated drift correction are implemented and unit-tested, but lack live acoustic acceptance.
- A bounded `UniversalAudioCaptureAdapter` retains `MediaStreamTrackProcessor` as the preferred Chrome path and adds an exact-frame AudioWorklet path for future desktop evaluation. Path selection and framing are unit-tested, but the alternative path has not passed real-browser or acoustic parity, so it does not expand H3 support.
- Presenter AI responses are scripted and labelled. There is no live recognition, model, synthesis or AI-worker transport pipeline.
- H3 now requires a documented matrix of all supported browser, OS and major-version combinations. The current client recognises only provisional Chrome 141+ on macOS, so cross-browser support remains open.
- Unit tests do not satisfy the live trace, acoustic latency, measured-capacity, audible ten-minute or two-clean-run acceptance gates.

Keep this snapshot current when implementation status changes. Never convert an implemented component or a passing unit test into a claim that a live acceptance boundary has passed.

## Product invariants

- Live audio uses MOQT objects over WebTransport, HTTP/3 and QUIC through a real MoQ relay. There is no WebRTC or WebSocket audio fallback.
- Each human and AI publishes one independent audio track. The relay and room service never mix audio.
- Membership is open and has no configured participant cap. Degrade visibly when measured client capacity is exceeded; never reject a join to preserve performance.
- Any composition with at least one human is valid.
- Headphones are required and must be stated before joining and in the room.
- Each AI has its own address and speaks only when addressed.
- No AI subscribes to another AI by default.
- Each human independently controls, per AI, “Hears me” and “I hear it”. Subscription changes must be visible in the inspector.
- Label inbound AI routing as enforced only when relay credentials enforce it. Otherwise label it cooperative.
- Barge-in must stop the addressed AI audibly within 300 ms, including queued receiver objects.
- Reload within 60 seconds reclaims identity and routing without duplicate playback.
- Unobservable measurements read “Not exposed”, never zero.
- Every specified failure has a distinct, non-silent state. Never hide a protocol failure behind presenter simulation.
- No audio or transcript content is retained.

## v1 boundaries

Video, screen sharing, recording, captions, dial-in, accounts, mobile publishing, moderation, WebRTC comparison, or production-readiness claims will come later.

Presenter simulation is required, but simulated participants and scripted AI responses must be unmistakably labelled. Simulation must never masquerade as a working relay or AI pipeline.

## Architecture

### Web application

- Use React, TypeScript and Vite.
- Keep `App` as composition glue. Put feature behaviour in focused components, hooks and modules.
- Keep interactive text and controls code-native.
- Model capability, transport and participant states explicitly; avoid booleans whose meaning changes by screen.
- Use local optimistic state only when the server or transport remains authoritative and reconciliation is defined.

### Cloudflare Worker

- Serve the built frontend through Workers Static Assets.
- Use one Durable Object per room for strongly consistent membership, routing and rejoin state.
- Use SQLite-backed Durable Object storage for critical room state. In-memory state is a cache only.
- Use RPC methods for ordinary Durable Object operations. Use a Durable Object `fetch` handler only where the WebSocket upgrade requires it.
- WebSockets may carry control-plane membership or discovery events only. They must never carry audio.
- Generate binding types with `wrangler types`; do not hand-write a duplicate `Env` interface.
- Use `crypto.randomUUID()` or `crypto.getRandomValues()` for identifiers and tokens.
- Await every promise or pass deliberate post-response work to `ctx.waitUntil()`.
- Keep request-specific state out of module globals.
- Emit structured logs with stable room, participant, request and correlation IDs. Never log display names, tokens, transcript text, device labels or audio.

### MOQT boundary

`MoqTransportAdapter` is the only module allowed to contain draft constants, wire-message encoding, draft-specific state transitions or client-library compatibility shims.

It exposes:

```text
connect(endpoint, credential, draft)
publish(track, object)
subscribe(track, startPosition)
subscribeNamespace(namespace)
unsubscribe(track)
sessionStats()
close(reason)
```

The UI, room service, telemetry and audio pipeline depend on this interface, not directly on a MOQT library.

Treat the current `moqtail` dependency as draft-sensitive. Keep imports local to the adapter and pin its exact version. Re-evaluate interoperability when draft 20 is published.

### Audio pipeline

- Capture mono voice with echo cancellation, noise suppression and automatic gain where supported.
- Encode Opus at 48 kHz, 32 kbit/s and 20 ms frames.
- Use DTX when the chosen browser encoder exposes it; otherwise report it as unavailable rather than pretending it is enabled.
- Use one bounded adaptive jitter buffer per subscribed track.
- Sum decoded tracks only in the listener’s AudioWorklet against one output clock.
- Drop stale objects, count the drop and keep latency bounded.
- Close capture, encoders, decoders, worklets, publications and subscriptions on leave.

## User experience

Use the design references in `design/concepts/` as the visual direction:

- graphite-black background;
- near-white type;
- cyan for transport and subscriptions;
- coral for live audio and publication;
- green for passing state and amber for degradation or reconnection;
- precise rails, square status lights, minimal radius and restrained shadows;
- editorial sans-serif for content and monospace for protocol data.

Avoid decorative card grids, bento layouts, neon glow, purple gradients, fake metrics, avatars, stock imagery and generic dashboard chrome.

The desktop room keeps the participant surface primary and the protocol inspector persistently visible. Narrow screens are read-only and must state that desktop Chrome is required for live audio until a mobile configuration has been verified.

Preserve these entry strings unless the product specification changes:

- “People and AIs speaking over Media over QUIC.”
- “Headphones required”
- “Create demo room”
- “Join room”
- “Solo presenter mode”
- “Run pre-flight only”

## Security and privacy

- Share links contain only a non-guessable room join code, never relay credentials.
- Mint short-lived, least-privilege relay credentials server-side.
- Keep Cloudflare account tokens and relay secrets in Worker secrets, never source, configuration or client bundles.
- Use opaque relay-visible room and participant identifiers.
- Store only the minimum ephemeral room state required for rejoin and routing.
- Sanitised telemetry exports must exclude audio, transcripts, credentials, display names and microphone device labels.
- Rate-limit room creation and credential minting. Hard-stop rooms at 20 minutes and terminate their AI pipelines.

## Repository and dependency discipline

- Use pnpm and honour the committed lockfile and `packageManager` field.
- Prefer platform APIs and existing dependencies. Ask before introducing an additional production dependency unless it is required to implement the requested behaviour.
- Keep protocol packages exactly pinned because MOQT APIs are draft-sensitive.
- Do not perform unrelated refactors, dependency upgrades or formatting churn.
- Preserve unrelated user files and changes, including untracked specifications.
- Never commit secrets, generated local state, `.DS_Store`, `.dev.vars`, build output or `node_modules`.

### OneDrive dependency storage

The canonical checkout and Git metadata are stored in OneDrive, and linked Codex worktrees may live elsewhere. For every checkout or worktree, `node_modules` must remain physically outside both the repository and OneDrive.

- The only approved physical dependency directory for this checkout is `/Users/mccannstuart/.node_modules`.
- The repository path `node_modules` must be a symbolic link to that directory. Never replace it with a physical directory.
- Before running a tool that reads dependencies, verify both `test -L node_modules` and `test "$(readlink node_modules)" = "/Users/mccannstuart/.node_modules"`.
- If the external directory exists but the repository link is absent, recreate the link with `ln -s /Users/mccannstuart/.node_modules node_modules`.
- If `node_modules` is a physical directory, or the external target already contains different data, stop and inspect both locations. Do not merge, delete or overwrite either location without explicit user approval.
- Use the repository-pinned pnpm 11.22.0 and committed `pnpm-lock.yaml`. After verifying the symlink, install with `pnpm install --frozen-lockfile --modules-dir /Users/mccannstuart/.node_modules`; the explicit modules directory is required because plain `pnpm install` refuses to reify a symlink target outside the project root.
- Never run `npm install` in this repository. npm 11 removes a symlinked top-level `node_modules`, and this project is pnpm-managed.
- After any dependency-changing pnpm command using the explicit `--modules-dir` target, re-run both symlink checks and confirm `realpath node_modules` is `/Users/mccannstuart/.node_modules` before continuing.

## GitHub and Git operations

- The canonical repository is [mccann-stuart/real-fabric](https://github.com/mccann-stuart/real-fabric).
- Keep `origin` set to `https://github.com/mccann-stuart/real-fabric.git`. Confirm the remote, current branch and working tree before changing files or contacting GitHub.
- Treat `main` as the integration branch. For implementation work, create a focused `codex/<short-scope>` branch unless the user explicitly requests a different branch or a direct `main` update.
- Before starting a branch, fetch `origin` and base it on the current `origin/main`. Use fast-forward updates where possible.
- Preserve all unrelated tracked and untracked user work. Never use broad clean-up, destructive checkout, hard reset or history rewriting to make the tree look clean.
- Keep commits focused and use short imperative commit messages. Do not mix generated files, product changes and unrelated formatting in one commit.
- Before committing or pushing, inspect the complete diff, run `git diff --check`, run the relevant verification commands, confirm no secrets or local artefacts are included, and confirm the tested commit is the commit being pushed.
- Push the feature branch to `origin`; do not force-push, amend, rebase, squash, merge, delete branches or update `main` unless the user explicitly authorises that operation.
- Do not create or merge a pull request merely because a branch exists. When a pull request is requested, report its URL, exact head commit, checks and merge state.
- Treat GitHub checks and Cloudflare deployment checks as separate gates. A successful Cloudflare build does not prove tests, lint, type checks or security checks passed.

## Cloudflare operations

- The canonical production dashboard is [Cloudflare Worker `real-fabric` — production](https://dash.cloudflare.com/2e3895c5eec3a37afbe1e4df68e4be28/workers/services/view/real-fabric/production).
- The exact production target is account `2e3895c5eec3a37afbe1e4df68e4be28`, Worker `real-fabric`, environment `production`. Resolve and re-check all three before any write.
- `wrangler.jsonc` is the source of truth for Worker configuration.
- Use today’s compatibility date for a new project and enable `nodejs_compat`.
- Enable structured logs and sampled traces before production deployment.
- Run `wrangler types` after binding changes and validate against Wrangler’s bundled schema.
- Before a deploy, run `wrangler whoami` and confirm it is authenticated to the expected account. Do not continue from an unexpected account or target.
- Before a production deploy, record the current deployment/version identifier and inspect existing bindings, routes, custom domains, compatibility settings, secrets by name only, and observability configuration. Never print secret values.
- Run the full relevant test, lint, type-check and build gates plus `wrangler deploy --dry-run`. Review the generated upload and confirm it targets only `real-fabric`.
- Do not assume a GitHub push deployed production. Do not assume a successful deployment updated GitHub. Reconcile and verify both surfaces independently.
- Do not edit production code in the Cloudflare dashboard when the repository can be updated. If an explicitly authorised emergency dashboard edit is unavoidable, immediately reconcile the exact change back into Git so the dashboard does not become a hidden source fork.
- Do not create relays, set or rotate secrets, enable public routes, attach domains, deploy, roll back, migrate or otherwise alter production infrastructure without explicit user authority for that exact action.
- An authorised production deploy uses the repository’s pinned Wrangler version and deploy script. Do not deploy from a globally installed version when the project version is available.
- After deployment, verify the new deployment/version ID, configured routes or `workers.dev` exposure, the live health and application endpoints, relevant browser behaviour and Workers logs. Report the exact boundary verified; a dashboard “success” state alone is insufficient.
- If verification fails, stop further rollout actions, preserve the failed deployment evidence and recommend the safest versioned rollback. Do not roll back automatically without authority.

## Verification

Use the narrowest useful checks during development and the complete set before handoff:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm deploy:dry-run
```

Also verify in a real browser:

- desktop entry and pre-flight;
- create, join, leave and 60-second rejoin;
- presenter simulation;
- per-AI routing controls and inspector edge changes;
- unsupported-browser and relay-unavailable states;
- microphone permission denial and no-input-device states;
- desktop and narrow read-only layouts;
- no WebRTC or WebSocket audio path in code or network traffic.

The current `/preflight` page verifies browser APIs and the room-service health gate only. Do not record the relay/UDP check as passed until an active UDP/HTTP-3 probe exists and runs successfully.

When a live draft-20 relay exists, the release gate additionally requires a reproducible trace proving MOQT over WebTransport and HTTP/3/QUIC, plus the product specification’s ten-minute reference-composition run and complete demo script twice.

Do not claim a check passed unless it ran and passed. If draft-20 availability prevents a live check, report that precise residual risk while continuing all independent work.

## Definition of done

A change is done only when it is scoped, tested, self-reviewed, documented where behaviour changed, truthful about unavailable transport data, and free of unrelated file changes or secrets.
