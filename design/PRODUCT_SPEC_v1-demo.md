# Real Fabric design implementation reference

**Status:** Non-canonical design companion

**Last reconciled with code:** 25 August 2026, current repository state

The binding product requirements and acceptance gates live in [`../PRODUCT_SPEC_v1-demo_1.md`](../PRODUCT_SPEC_v1-demo_1.md). This file no longer duplicates that specification: the previous copy had drifted into an operational draft-16 plan that contradicted the implemented draft-20-only transport gate.

## Visual sources

The current client follows these concept images:

- [`concepts/entry.png`](concepts/entry.png) — entry, capability checks and room creation.
- [`concepts/room.png`](concepts/room.png) — participant surface with the protocol inspector kept visible.
- [`concepts/mobile.png`](concepts/mobile.png) — narrow read-only treatment.

The implementation is in [`../src/client/styles.css`](../src/client/styles.css), [`../src/client/pages`](../src/client/pages) and [`../src/client/components`](../src/client/components).

## Current routes and surfaces

| Route or surface | Current implementation |
|---|---|
| `/` | Entry page with display name, 20-character room code, microphone level test, create, join, configurable solo presenter mode and a pre-flight link. |
| `/preflight` | Browser capability checks, microphone permission test, pinned-configuration warning and room-service health gate. In-room `NetworkProbe` can test a configured relay, but currently returns `not_run` because no draft-20 endpoint is configured. |
| `/room/:code` | Participant layout, per-AI routing controls, presenter strip, demo-script runner, subscription graph, protocol inspector, failure banners and sanitised telemetry export. |
| Narrow viewport | Read-only room presentation. The code currently recognises Chrome 141+ on macOS only; H3's broader supported-browser matrix remains open. |

## Design invariants reflected in code

- Graphite-black background, near-white type, cyan transport/subscription accents, coral live-audio/publication accents, green passing states and amber degradation/reconnection states.
- Precise rails, square status lights, restrained rounding and no decorative card-grid or avatar treatment.
- Participant cards remain primary while the inspector stays persistently visible on desktop.
- Simulated participants and scripted AI responses are labelled wherever they appear.
- Unobservable figures render **Not exposed**, never zero.
- The preserved entry strings are “People and AIs speaking over Media over QUIC.”, “Headphones required”, “Create demo room”, “Join room”, “Solo presenter mode” and “Run pre-flight only”.

## Known design and acceptance gaps

- Live transport is blocked because no draft-20 endpoint is configured and the pinned client cannot frame draft 20. Credential minting exists but is inactive without an endpoint and has no live relay acceptance evidence.
- Chrome 141+ on macOS is the only currently recognised configuration; it is provisional and does not satisfy H3's supported-browser matrix.
- No live relay or UDP probe result exists; the configured-endpoint probe returns `not_run` in the current configuration.
- The presenter health strip is not technically excluded from screen capture; capture framing is a presenter responsibility.
- Live AI workers, wake-name detection, audible barge-in, reference-hardware capacity and the two clean venue-network demo runs remain unverified.

Any future design change that alters product behaviour must update the canonical specification first, then this implementation reference and the relevant client code together.
