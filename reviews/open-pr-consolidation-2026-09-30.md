# Open PR consolidation — 30 September 2026

This review covered all 39 open pull requests (#204–#242) against `origin/main` at `b1b182ba3e6cd796ac515a76442bb078d4125824`. The proposals overlap in five areas, so this branch rebuilds the useful changes together instead of stacking conflicting heads. The source PRs were closed after #243 merged, without deleting their branches.

| Source PRs | Decision | Reason and resulting change |
| --- | --- | --- |
| #206, #209, #212, #214, #220, #224, #225, #230, #231, #239, #242 | Rebuilt | Main already validates presenter authority and the requested AI. The remaining gap was stale holder and queue state. This branch filters invalid queue entries, preserves waiting order when a holder departs, advances after AI reconnect expiry, and covers those paths with Durable Object tests. SEC-03 remains open until release is bound to an AI turn lease. |
| #236 | Accepted | Adds `Cross-Origin-Opener-Policy: same-origin` and an HTTP response assertion. |
| #217 | Deferred | Its two-year HSTS policy includes `includeSubDomains` and `preload`; the repository has no evidence that every production subdomain and future route can meet that commitment. The additional cross-domain header adds no relevant protection. |
| #213, #219, #233, #238, #240 | Rebuilt | One expandable, visible table accompanies the graph. It reports only accepted subscriptions and the viewer's own AI consent, and marks absent routing `Not exposed`. It retains simulated-participant labels without duplicating them. |
| #223, #229 | Superseded | SVG titles and tooltips do not give a reliable keyboard or screen-reader view of every connection. The table provides that view without making graph nodes interactive. |
| #204, #207, #216 | Accepted | Adds dismiss-button focus and hover states, keyboard guidance for hold-to-ask, and an inspector-close tooltip. |
| #211 | Partially accepted | Improves the leave dialog and labels its triggers. Implicit Enter-to-create behaviour was left out because the entry page has several actions and needs explicit user intent. |
| #227, #234 | Rebuilt | Entry and room microphone meters expose measured levels only while available. A one-shot mic test remains a button, without a misleading pressed state. |
| #215, #241 | Rebuilt | Uses contiguous `TypedArray.set` writes in the mixer ring and handles inputs longer than one full ring without truncation. Output clearing uses `fill(0)`. |
| #221, #237 | Partially accepted | Reuses the packet-loss concealment buffer while copying incoming frames so later input-buffer reuse cannot alter stored audio. The separate TrackPlayer eviction change was not needed. |
| #228, #235 | Accepted | Reduces per-frame metadata and event-log array allocations while preserving flags, retention order and earlier snapshots. |
| #205, #222, #226, #232 | Deferred | Drift-estimator rewrites replace simple local work with shared scratch state or unmeasured sorting changes in an acoustic-critical path. There is no benchmark or acoustic acceptance evidence for a gain. |
| #208 | Deferred | The RMS loop rewrite lacks a measured gain on reference hardware. |
| #210 | Deferred | Its parsing shortcut changes which track strings are accepted; the deduplication path is already bounded. |
| #218 | Deferred | Eviction already has a fixed bound, and the proposed change has no demonstrated user-visible or measured capacity benefit. |

## Verification

- Biome check, TypeScript build check, Vite production build and Wrangler deploy dry run passed using the repository's pinned local binaries.
- Vitest passed: 447 tests across 27 files.
- A local desktop browser showed entry, room creation, presenter simulation, the expandable graph table, a consent toggle reflected as `On (cooperative)`, and the Stay action in the leave dialog. The local Worker had no usable relay credential and the relay reachability probe timed out, so this run did not verify live audio or browser-to-relay transport.
- The ring-buffer implementation was compared with the previous per-sample reference on ordinary, wrapped and greater-than-ring writes in a Node VM using the actual worklet source.

The `pnpm` launcher installed on this host is not the repository's pinned version, so the equivalent pinned local binaries were used for these checks. This branch does not deploy production or change relay credentials.
