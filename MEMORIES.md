# Project Memory

## External dependency directory

Decision recorded 25 August 2026: OneDrive sync is unreliable for the large, frequently changing `node_modules` tree. Dependencies for this checkout must live at `/Users/mccannstuart/.node_modules`, with `node_modules` in the repository kept as a symbolic link to that location.

This is a strict, persistent project constraint:

- Do not put a physical `node_modules` directory anywhere inside this OneDrive-backed repository.
- Do not remove or replace the repository symlink during installs, builds, tests, repairs, or upgrades.
- Before using dependencies, require both `test -L node_modules` and an exact `readlink` target of `/Users/mccannstuart/.node_modules`.
- If either check fails, stop before installing. Preserve both locations and resolve the discrepancy without deleting or overwriting dependency data.
- The repository now has `package.json`, `pnpm-lock.yaml` and `packageManager: pnpm@11.22.0`. After the symlink checks, install with `pnpm install --frozen-lockfile --modules-dir /Users/mccannstuart/.node_modules`. Plain `pnpm install` refuses to reify an external symlink target; the explicit modules directory is mandatory. Never use `npm install`, because npm 11 removes the top-level symlink. Re-check the symlink and `realpath node_modules` after dependency changes.
- A linked Codex worktree may start without its own `node_modules` entry. If the approved external directory exists and the worktree path is absent, recreate the symlink only; do not reinstall or replace the external tree merely to repair the link.

## Current product snapshot

The binding product specification is `PRODUCT_SPEC_v1-demo_1.md`, reconciled with the implementation on 25 August 2026. It defines an open-membership stage demo with independent human and AI MOQT tracks, per-AI routing controls, no WebRTC or WebSocket audio fallback, and live transport isolated behind `MoqTransportAdapter`.

The current repository implements Milestones 1 and 2: SQLite Durable Object room service, control-plane WebSocket, presenter simulation, browser media pipeline, inspector, failure registry, telemetry, provisioned Cloudflare relay-token handling, draft-free network probe, dynamic device tracking, packet-loss concealment, bounded drift/recovery behaviour, and live draft-16 transport against Cloudflare isolated relays, with 113 automated tests across eight files. Gate 1 transport acceptance remains open: `MOQT_TRANSPORT_VERIFIED` is `false`, and no browser-to-relay trace has been recorded. The client recognises provisional Chrome 141+ on macOS, while H3 requires a documented supported-browser matrix. Cross-browser acceptance, the live AI pipeline, live UDP/HTTP-3 probe trace, measured capacity, audible ten-minute run and two clean demo-script runs remain open and must not be represented as verified.
