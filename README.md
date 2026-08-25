# Real Fabric

> People and AIs speaking over Media over QUIC.

Real Fabric is a conference-stage demonstration of humans and AI agents speaking over independent Media over QUIC tracks while an inspector shows relay fan-out, subscriptions, routing changes and failure states.

## Status

The project scaffold is implemented. It includes the responsive React room experience, standalone pre-flight, clearly labelled presenter simulation, protocol inspector, sanitised telemetry export, media framing and jitter-buffer primitives, and a Cloudflare Worker control plane backed by one SQLite Durable Object per room. Room creation, joining, leaving, 60-second identity reclaim, short-lived local participant credentials, creation rate limiting and control-only WebSocket upgrades are covered by automated tests.

Live transport remains deliberately blocked. The v1 specification targets MOQT `draft-ietf-moq-transport-20`, but the required browser-to-relay interoperability has not passed Gate 1 and the room service does not mint relay credentials. The UI therefore shows a specific draft-unavailable state. `MoqTransportAdapter` is the only draft-sensitive boundary and there is no WebRTC or WebSocket audio fallback.

The pinned browser, operating system and major version are not yet assigned. Measured participant capacity is also pending. Do not present either as verified.

## Product invariants

- Every human and AI publishes one independent audio track; the relay never mixes audio.
- Membership is open, with at least one human required and no configured participant cap.
- Each AI speaks only when addressed and does not subscribe to other AIs by default.
- Each human independently controls whether each AI hears them and whether they hear that AI.
- Barge-in must silence the addressed AI audibly within 300 ms.
- Reload within 60 seconds must reclaim identity and routing without duplicate playback.
- Unobservable measurements display **Not exposed**, never zero.
- No audio or transcript content is retained.

See [PRODUCT_SPEC_v1-demo_1.md](PRODUCT_SPEC_v1-demo_1.md) for the binding product scope and acceptance gates.

## Implemented scaffold

- `src/client`: entry, pre-flight, desktop room, narrow read-only room, presenter simulation, per-AI routing controls, inspector, capability checks and sanitised telemetry.
- `src/client/transport/MoqTransportAdapter.ts`: the pinned `moqtail` integration boundary for connect, publish, subscribe, namespace discovery, unsubscribe, session statistics and close.
- `src/client/audio`: mono capture configuration, versioned Opus-object framing and a bounded adaptive jitter buffer.
- `src/worker`: Worker API routing, security headers, structured redacted logs and SQLite Durable Object room state.
- `test`: unit and local Workers-runtime integration coverage for request validation, media framing, jitter buffering, room creation and 60-second rejoin.

This is a completed project scaffold, not a claim that Gates 1–4 have passed. The live audio pipeline, relay credentials, AI providers, measured capacity and venue-network acceptance remain gated by the product specification.

## Local setup

This checkout is stored in OneDrive. Its physical dependency tree must remain outside OneDrive at `/Users/mccannstuart/.node_modules`, with the repository path symlinked to it:

```sh
test -L node_modules
test "$(readlink node_modules)" = "/Users/mccannstuart/.node_modules"
test "$(realpath node_modules)" = "/Users/mccannstuart/.node_modules"
pnpm install --frozen-lockfile --modules-dir /Users/mccannstuart/.node_modules
```

Use the pinned pnpm 11.22.0 from `package.json` and always pass the explicit external `--modules-dir` shown above. Plain `pnpm install` refuses to reify a symlink target outside the project root. Never run `npm install`: npm 11 removes a symlinked top-level `node_modules` and would put dependency churn back under OneDrive.

## Development commands

```sh
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm deploy:dry-run
```

Run the full check set with:

```sh
pnpm check
```

Production deployment requires separate, explicit authorisation. A successful local build or GitHub push is not a production deployment.
