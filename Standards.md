# Real Fabric platform standards and compatibility matrix

**Status:** Living implementation reference
**Last reconciled with code:** 25 August 2026, current repository state

This document records what the current code requires and what evidence is needed before another browser or operating system can be called supported. It does not expand the v1 boundary in [`PRODUCT_SPEC_v1-demo_1.md`](PRODUCT_SPEC_v1-demo_1.md), authorise a transport downgrade, approve new production dependencies or make a production-readiness claim.

## 1. Current platform contract

Real Fabric's media path is intentionally narrow:

```text
getUserMedia
  -> MediaStreamTrackProcessor
  -> WebCodecs AudioEncoder (Opus)
  -> MoqTransportAdapter
  -> WebTransport / HTTP/3 / QUIC / MOQT draft 20
  -> WebCodecs AudioDecoder (Opus)
  -> one listener-side AudioWorklet mixer
```

The current code requires:

- a secure context;
- `WebTransport`;
- WebCodecs `AudioEncoder` with Opus at 48 kHz, mono and 32 kbit/s;
- `MediaStreamTrackProcessor` for capture;
- WebCodecs `AudioDecoder` for received Opus;
- `AudioWorkletNode` and a running `AudioContext` for listener-side playout;
- a compatible MOQT endpoint and a server-minted relay credential.

The last condition is unavailable. The relay URL is unset, `MOQT_TRANSPORT_VERIFIED=false`, and the pinned `moqtail@0.12.1` client frames draft 16 but not draft 20. The adapter refuses to downgrade, the room service returns no credential and no browser can be described as live-audio verified. Credential minting and relay reachability probing are implemented for use when a compatible endpoint exists; neither has passed live relay acceptance.

## 2. Standards used by the implementation

| Standard or API | Maturity | Current role |
|---|---|---|
| [QUIC](https://www.rfc-editor.org/info/rfc9000) | IETF Standards Track RFC | Transport beneath HTTP/3. |
| [HTTP/3](https://www.rfc-editor.org/info/rfc9114) | IETF Standards Track RFC | WebTransport's HTTP/3 session layer. |
| [WebTransport](https://www.w3.org/TR/webtransport/) | W3C Working Draft | Browser session used by the MOQT client. |
| [MOQT](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) | IETF Internet-Draft; `-19` published as checked on 25 August 2026 | Earlier drafts are not a live-audio fallback. |
| [WebCodecs](https://www.w3.org/TR/webcodecs/) | W3C Candidate Recommendation Draft | Native Opus encode/decode. |
| [Opus](https://www.rfc-editor.org/info/rfc6716) | IETF Standards Track RFC | 48 kHz mono voice, 32 kbit/s, 20 ms frames. |
| [Web Audio API](https://www.w3.org/TR/webaudio/) | W3C Recommendation | Output clock and listener-side mixing worklet. |
| [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) | W3C Recommendation | Microphone capture with echo cancellation, noise suppression and automatic gain where exposed. |

MOQT draft-specific library compatibility stays inside [`src/client/transport/MoqTransportAdapter.ts`](src/client/transport/MoqTransportAdapter.ts). The adapter registry and tests may describe earlier drafts for compatibility research, but the application may attempt live audio only with draft 20.

## 3. Current compatibility matrix

The legend describes repository behaviour, not general browser capability:

- **Recognised, unaccepted** — the user-agent check accepts the configuration, but live transport and browser acceptance remain open.
- **Warned / unverified** — the UI shows “not the tested configuration”. Some APIs may exist, but the repository has no passing compatibility evidence.
- **Read-only design** — narrow-screen product policy prevents live publication even if individual APIs exist.

| Platform | Browser | Current repository state | Evidence still required |
|---|---|---|---|
| macOS | Google Chrome 141+ | **Recognised, unaccepted.** This is the only configuration accepted by `matchConfiguration`. | Relay trace, real capture/playout, ten-minute run, latency, capacity and demo-script acceptance. |
| macOS | Edge, Safari, Firefox and other browsers | **Warned / unverified.** Brand detection rejects them. | Capability audit, implementation changes where needed and the full acceptance suite. |
| Windows or Linux | Any browser | **Warned / unverified.** The platform check accepts macOS only. | Capability audit and full acceptance suite on each named combination. |
| iOS / iPadOS | Any browser | **Read-only design and unverified.** Mobile publishing is outside v1. | Separately approved scope plus autoplay, route-change, backgrounding and real-device acceptance. |
| Android | Any browser | **Read-only design and unverified.** Mobile publishing is outside v1. | Separately approved scope plus audio-focus, route-change, backgrounding and real-device acceptance. |

Do not infer support from a shared browser engine. Branding, policies, codecs, permissions, enterprise configuration and release packaging still require direct verification.

## 4. H3 support rule

A browser, operating system and major-version combination enters the README's supported list only after all of these pass:

1. capability detection and truthful unsupported-state copy;
2. microphone denial, absence and device-change behaviour;
3. real MOQT publication and subscription over WebTransport / HTTP/3 / QUIC;
4. Opus capture, decoding, packet-loss concealment and AudioWorklet mixing;
5. create, join, leave and 60-second identity/routing reclaim;
6. per-AI routing and inspector edge reconciliation;
7. audible barge-in within 300 ms, including queued receiver objects;
8. bounded reconnection, relay probing and every applicable failure state;
9. the ten-minute reference-composition run without audible drift or unbounded buffers;
10. two clean demo-script runs and a sanitised telemetry review.

Until a combination meets all ten conditions, document it as unverified.

## 5. Current automated coverage

The suite has 113 passing automated tests across eight files. It covers room and Worker behaviour, validation, MOQT setup framing, credential scope and lifetime, network-probe classification, jitter buffering, packet-loss concealment, device changes, routing, presenter simulation, failure-registry invariants, telemetry sanitisation, reconnection policy, layout logic and synthetic long-run buffer bounds.

Automated tests do not provide:

- a browser matrix or browser end-to-end suite;
- a live relay trace or UDP/HTTP-3 probe result;
- relay acceptance, enforcement or expiry of a minted credential;
- acoustic p50/p95 latency or audible concealment evidence;
- live AI-worker or wake-name coverage;
- publisher-side barge-in cancellation-marker proof;
- reference-hardware capacity measurements;
- real mobile lifecycle or device-route tests;
- the audible ten-minute or two clean venue-network runs.

## 6. Candidate desktop capture boundary

`MediaStreamTrackProcessor` is the first code-level barrier to evaluating Safari and Firefox as future desktop configurations. A proposed `UniversalAudioCaptureAdapter`, mobile support and Wasm codec are not implemented or approved, so they are recorded here as a decision boundary rather than as the current architecture.

The smallest useful boundary would let `CaptureController` select a capture source without changing the encoder, room or transport contracts:

```text
microphone MediaStreamTrack
  -> capture adapter
       -> current MediaStreamTrackProcessor path
       -> candidate MediaStreamAudioSourceNode + capture AudioWorklet path
  -> exact 960-sample mono frames at 48 kHz
  -> existing Opus encoder and publication path
```

Any implementation of that boundary must meet these constraints:

- Keep the current `MediaStreamTrackProcessor` path available until the alternative has equivalent measured behaviour on the recognised Chrome/macOS configuration.
- Aggregate browser render quanta into exact 20 ms, 960-sample frames with monotonic media timestamps.
- Bound queues and pre-allocate or pool worklet-thread storage. The `process()` callback must not perform blocking work, resize buffers or create an unbounded allocation rate.
- Treat transferable `ArrayBuffer` messages and `SharedArrayBuffer` ring buffers as different designs. Transfer can avoid a copy but still requires storage management; shared memory additionally requires a verified cross-origin-isolated deployment.
- Keep voice-onset detection local and fast enough to leave a measured end-to-end budget for H6. A local callback or unit test does not prove audible stop within 300 ms.
- Preserve `Measurement` truthfulness for DTX, levels, timing and unsupported codec features.
- Keep codec selection behind a separate interface if a second implementation is approved. A Wasm Opus fallback would be a new production dependency and needs explicit approval, licensing review, bundle-size measurement and native-versus-Wasm parity tests.

This candidate addresses future desktop evaluation only. Mobile publishing, background lifecycle handling and communications-audio routing remain outside v1 and require a separate product decision.

### 6.1 Existing playback, drift and barge-in seams

Useful parts of the proposed design already exist in narrower, tested forms:

- [`DriftEstimator.ts`](src/client/audio/DriftEstimator.ts) compares sender media time with local arrival time; [`MixerGraph.ts`](src/client/audio/MixerGraph.ts) applies bounded correction; [`TrackPlayer.ts`](src/client/audio/TrackPlayer.ts) defers an uncorrectable-drift rebuild until silence, with a bounded maximum wait.
- [`AdaptiveJitterBuffer.ts`](src/client/audio/AdaptiveJitterBuffer.ts) and `TrackPlayer.cancelGroup` discard queued and later-arriving objects from a cancelled group, then flush that track from the mixer.
- [`RoomSession.ts`](src/client/session/RoomSession.ts) connects the local barge-in decision to the cancellation marker and receiver cleanup.

Those components establish testable seams; they do not establish acoustic quality, live cancellation propagation or the H6/H13 acceptance gates. The receiver worklet and live relay remain the evidence boundary.

## 7. Test expansion and gate matrix

The test plan separates fast deterministic tests from browser, relay, acoustic and real-device evidence. It does not invent delivery dates, arbitrary coverage percentages or tests for files that do not exist.

| Tier | Purpose | Current evidence | Next evidence boundary |
|---|---|---|---|
| 1 — unit and subsystem | Deterministic contracts, state machines and bounded media behaviour | 113 Vitest tests across eight files | Add focused tests with each new seam; keep protocol and failure-state assertions exact. |
| 2 — browser integration | Entry, pre-flight, room lifecycle, routing controls, inspector and capability states | Manual browser acceptance remains outstanding | Automate the recognised Chrome/macOS flow first; add another browser only after its capture and codec path exists. |
| 3 — live media and acoustic | Real transport, latency, drift, concealment and audible barge-in | Synthetic timing and buffer tests only | Capture a browser-to-relay trace, then run calibrated acoustic and cancellation measurements. |
| 4 — venue, capacity and endurance | Reference composition, degradation, network recovery and demo reliability | No measured-capacity or audible endurance result | Run the ten-minute reference composition and the complete demo script twice on the venue network and hotspot. |

### 7.1 Delivery-gate mapping

| Gate | Automated work that may proceed now | Evidence that closes the gate |
|---|---|---|
| Gate 1 — transport and relay | Adapter contract tests, draft refusal, credential scope, network-probe classification and failure-state copy | A reproducible browser-to-relay trace showing MOQT objects over WebTransport and HTTP/3/QUIC, plus credential acceptance and relay behaviour. |
| Gate 2 — audio pipeline | Device changes, bounded jitter, concealment, drift estimation, silence-gated rebuild and synthetic long-run bounds | Calibrated p50/p95 acoustic latency, audible concealment review and the ten-minute reference-composition run without audible drift or unbounded growth. |
| Gate 3 — AI and floor control | Scripted addressing, queueing, turn caps, cancellation-group and telemetry tests | Two live AI pipelines, ten addressed exchanges, audible barge-in within 300 ms and routing changes within 500 ms. |
| Gate 4 — discovery, rejoin and capacity | Room-service discovery fallback, 60-second reclaim, deduplication, failure registry and degradation logic | Live namespace behaviour recorded, measured client capacity, recovery under the reference network and two clean demo-script runs. |

### 7.2 CI promotion rule

1. Keep deterministic Tier 1 tests blocking on every pull request.
2. Add browser or live-media jobs as advisory while their external relay, browser or hardware prerequisite is unavailable.
3. Make a job blocking only after the corresponding environment is stable and the acceptance boundary has passed at least once reproducibly.
4. Do not replace live transport evidence with a socket mock. Mocks may verify adapter state and room semantics, but only the real trace can close Gate 1.
5. Assert **Not exposed** for unavailable measurements and the exact registered title, behaviour and recovery for each failure state.
6. Keep Cloudflare deployment status separate from lint, type-check, unit, build and acceptance results.

## 8. Expansion sequence

1. Complete Gate 1 on the currently recognised Chrome/macOS configuration when a compatible endpoint and client exist.
2. Capture a capability report for the next proposed desktop combination and identify the smallest missing seam.
3. If capture is the only missing seam, prototype the adapter boundary in §6 and measure it against the current path.
4. Add a production dependency only after explicit approval and a demonstrated native-API gap.
5. Add focused unit and browser tests for that seam.
6. Run the complete H3 support rule before naming the combination in the README.
7. Treat mobile publishing as a separate product decision because it is outside v1.

No roadmap date, coverage percentage, cross-browser support claim or device-cloud commitment is approved by the current repository.
