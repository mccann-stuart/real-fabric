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

The binding product specification is `PRODUCT_SPEC_v1-demo_1.md`, reconciled with the implementation on 10 September 2026. It defines an open-membership stage demo with independent human and AI MOQT tracks, per-AI routing controls, no WebRTC or WebSocket audio fallback, and live transport isolated behind `MoqTransportAdapter`.

The current repository implements Milestones 1 and 2: SQLite Durable Object room service, control-plane WebSocket, presenter simulation, browser media pipeline, inspector, failure registry, telemetry, provisioned Cloudflare relay-token handling, draft-free network probe, dynamic device tracking, packet-loss concealment, bounded drift/recovery behaviour, and live draft-16 transport against Cloudflare isolated relays, with 286 automated tests across twenty files. Recent security reviews have landed remediations for SEC-05 (in-message WebSocket authentication), SEC-06 (one active control socket per participant), SEC-07 (IP-based join rate limiting), SEC-08 (streaming 32 KiB JSON request body limit), SEC-09 (playback deduplication capped at 100 objects per group), and fail-closed rejection of expired relay credentials. The client recognises provisional Chrome 141+ on macOS, top-level Safari 27+ on macOS, top-level Safari 27+ on iOS 27 iPhone, and top-level Chrome for iOS 141+ on iOS 27 iPhone with an AudioWorklet capture path. Gate 1 transport acceptance is passed: a reproducible browser-to-relay packet and frame trace over WebTransport and HTTP/3/QUIC was recorded on 10 September 2026 (`reports/gate1-transport-trace.json`, `reports/gate1-transport.netlog`), and `MOQT_TRANSPORT_VERIFIED` is set to `true`.

## Next steps and vision statements

Forward-looking goals, unachieved acceptance criteria and roadmap targets are tracked here:

1. **Gate 1 transport acceptance (Completed 10 September 2026):** Recorded an end-to-end browser-to-relay trace over WebTransport and HTTP/3/QUIC proving live MOQT negotiation and publication (`reports/gate1-transport-trace.json`, `reports/gate1-transport.netlog`), and set `MOQT_TRANSPORT_VERIFIED=true`.
2. **MOQT draft 20 migration (Next step):** Update `moqtail` dependency and Worker endpoint configuration when draft 20 is published and supported by the relay.
3. **Tenant- and participant-scoped relay authorization (Vision statement):** Remediate the P1 shared credential disclosure by adopting a least-privilege token model that enforces room and participant namespaces at the relay boundary without participant caps.
4. **Gate 2 acoustic acceptance (Vision target):** Complete acoustic loopback latency validation (§9.4) and a continuous ten-minute reference composition run on reference hardware without drift or buffer overflow (H13).
5. **Measured capacity benchmark (Next step):** Benchmark degradation ladder triggers on target reference hardware to establish empirical participant capacity (§9.2, H7).
6. **Milestone 3 — AI orchestration and floor authority (Next step):** Implement authoritative Durable Object floor control, publishable AI audio tracks carrying labelled synthetic voice, publisher-side barge-in cancellation markers, and live speech pipeline interfaces (§11.4).
7. **Milestone 4 — Venue network validation (Vision target):** Complete two full clean runs of the §12 demonstration script on a venue network or mobile hotspot (H16).
8. **Physical mobile acceptance (Next step):** Execute the full browser acceptance suite on physical iPhone hardware for top-level Safari 27+ and Chrome for iOS 141+ under iOS 27.
