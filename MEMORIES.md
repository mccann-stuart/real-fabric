# Project Memory

## External dependency directory

Decision recorded 25 August 2026: OneDrive sync is unreliable for the large, frequently changing `node_modules` tree. Dependencies for this checkout must live at `/Users/mccannstuart/.node_modules`, with `node_modules` in the repository kept as a symbolic link to that location.

This is a strict, persistent project constraint:

- Do not put a physical `node_modules` directory anywhere inside this OneDrive-backed repository.
- Do not remove or replace the repository symlink during installs, builds, tests, repairs, or upgrades.
- Before using dependencies, require both `test -L node_modules` and an exact `readlink` target of `/Users/mccannstuart/.node_modules`.
- If either check fails, stop before installing. Preserve both locations and resolve the discrepancy without deleting or overwriting dependency data.
- The repository now has `package.json`, `pnpm-lock.yaml` and `packageManager: pnpm@11.22.0`. After the symlink checks, install with `pnpm install --frozen-lockfile --modules-dir /Users/mccannstuart/.node_modules`. Plain `pnpm install` refuses to reify an external symlink target; the explicit modules directory is mandatory. Never use `npm install`, because npm 11 removes the top-level symlink. Re-check the symlink and `realpath node_modules` after dependency changes.

## Current product snapshot

The binding product specification is `PRODUCT_SPEC_v1-demo_1.md` dated 25 August 2026. It defines an open-membership stage demo with independent human and AI MOQT tracks, per-AI routing controls, no WebRTC or WebSocket audio fallback, and a draft-20 target behind `MoqTransportAdapter`. Gate 1 transport proof, the pinned browser and OS, and measured capacity remain unresolved and must not be represented as verified.

