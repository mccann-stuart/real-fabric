# Real Fabric

> People and AIs speaking over Media over QUIC.

Real Fabric is a conference-stage demonstration of humans and AI agents speaking over independent Media over QUIC tracks while an inspector shows relay fan-out, subscriptions, routing changes and failure states.

## Status

The repository contains the React, TypeScript, Vite and Cloudflare Worker project configuration. Application and Worker source implementation is not yet present.

The v1 specification targets MOQT `draft-ietf-moq-transport-20`, but the required browser-to-relay interoperability has not passed Gate 1. The demo must show a specific relay- or draft-unavailable state until a real trace verifies transport. It must never silently fall back to WebRTC or WebSocket audio.

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
