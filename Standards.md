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
- a compatible MOQT draft-20 endpoint and a server-minted relay credential.

The last condition is unavailable. The relay URL is unset, `MOQT_TRANSPORT_VERIFIED=false`, and the pinned `moqtail@0.12.1` client frames draft 16 but not draft 20. The adapter refuses to downgrade, the room service returns no credential and no browser can be described as live-audio verified. Credential minting and relay reachability probing are implemented for use when a compatible endpoint exists; neither has passed live relay acceptance.

## 2. Standards used by the implementation

| Standard or API | Maturity | Current role |
|---|---|---|
| [QUIC](https://www.rfc-editor.org/info/rfc9000) | IETF Standards Track RFC | Transport beneath HTTP/3. |
| [HTTP/3](https://www.rfc-editor.org/info/rfc9114) | IETF Standards Track RFC | WebTransport's HTTP/3 session layer. |
| [WebTransport](https://www.w3.org/TR/webtransport/) | W3C Working Draft | Browser session used by the MOQT client. |
| [MOQT](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) | IETF Internet-Draft; `-19` published as checked on 25 August 2026 | Product target is unreleased draft 20. Earlier drafts are not a live-audio fallback. |
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
| macOS | Google Chrome 141+ | **Recognised, unaccepted.** This is the only configuration accepted by `matchConfiguration`. | Draft-20 relay trace, real capture/playout, ten-minute run, latency, capacity and demo-script acceptance. |
| macOS | Edge, Safari, Firefox and other browsers | **Warned / unverified.** Brand detection rejects them. | Capability audit, implementation changes where needed and the full acceptance suite. |
| Windows or Linux | Any browser | **Warned / unverified.** The platform check accepts macOS only. | Capability audit and full acceptance suite on each named combination. |
| iOS / iPadOS | Any browser | **Read-only design and unverified.** Mobile publishing is outside v1. | Separately approved scope plus autoplay, route-change, backgrounding and real-device acceptance. |
| Android | Any browser | **Read-only design and unverified.** Mobile publishing is outside v1. | Separately approved scope plus audio-focus, route-change, backgrounding and real-device acceptance. |

Do not infer support from a shared browser engine. Branding, policies, codecs, permissions, enterprise configuration and release packaging still require direct verification.

## 4. H3 support rule

A browser, operating system and major-version combination enters the README's supported list only after all of these pass:

1. capability detection and truthful unsupported-state copy;
2. microphone denial, absence and device-change behaviour;
3. real MOQT draft-20 publication and subscription over WebTransport / HTTP/3 / QUIC;
4. Opus capture, decoding, packet-loss concealment and AudioWorklet mixing;
5. create, join, leave and 60-second identity/routing reclaim;
6. per-AI routing and inspector edge reconciliation;
7. audible barge-in within 300 ms, including queued receiver objects;
8. bounded reconnection, relay probing and every applicable failure state;
9. the ten-minute reference-composition run without audible drift or unbounded buffers;
10. two clean demo-script runs and a sanitised telemetry review.

Until a combination meets all ten conditions, document it as unverified.

## 5. Current automated coverage

The suite has 111 passing automated tests across eight files. It covers room and Worker behaviour, validation, MOQT setup framing, credential scope and lifetime, network-probe classification, jitter buffering, packet-loss concealment, device changes, routing, presenter simulation, failure-registry invariants, telemetry sanitisation, reconnection policy, layout logic and synthetic long-run buffer bounds.

Automated tests do not provide:

- a browser matrix or browser end-to-end suite;
- a live draft-20 relay trace or UDP/HTTP-3 probe result;
- relay acceptance, enforcement or expiry of a minted credential;
- acoustic p50/p95 latency or audible concealment evidence;
- live AI-worker or wake-name coverage;
- publisher-side barge-in cancellation-marker proof;
- reference-hardware capacity measurements;
- real mobile lifecycle or device-route tests;
- the audible ten-minute or two clean venue-network runs.

## 6. Expansion sequence

1. Complete Gate 1 on the currently recognised Chrome/macOS configuration when a compatible draft-20 endpoint and client exist.
2. Capture a capability report for the next proposed desktop combination and identify the smallest missing seam.
3. Add a production dependency only after explicit approval and a demonstrated native-API gap.
4. Add focused unit and browser tests for that seam.
5. Run the complete H3 support rule before naming the combination in the README.
6. Treat mobile publishing as a separate product decision because it is outside v1.

No roadmap date, coverage percentage or device-cloud commitment is approved by the current repository.
