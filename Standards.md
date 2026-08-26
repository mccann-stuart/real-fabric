# Real Fabric platform standards and compatibility matrix

**Status:** Living implementation reference
**Last reconciled with code:** 26 August 2026

This document records the standards used by the current build, the exact browser and operating-system floors, and the evidence required before a configuration can be called supported. It does not authorise a transport downgrade, a production deploy or a claim that live MOQT interoperability has passed.

## 1. Current platform contract

Room membership and the control-plane WebSocket can start when the room opens. Live audio starts only from an in-room **Start audio** or **Resume audio** action:

```text
user activation
  -> Audio Session play-and-record hint, where exposed
  -> AudioContext + listener AudioWorklet
  -> getUserMedia
  -> UniversalAudioCaptureAdapter
       -> MediaStreamTrackProcessor, or
       -> MediaStreamAudioSourceNode + capture AudioWorklet
  -> exact 960-sample mono frames
  -> WebCodecs AudioEncoder (Opus)
  -> MoqTransportAdapter
  -> WebTransport requiring UDP-capable HTTP/3 / QUIC
  -> MOQT draft 16 on the currently configured relay
  -> WebCodecs AudioDecoder (Opus)
  -> one listener-side AudioWorklet mixer
```

The required local capabilities are a secure context, WebTransport, `AudioEncoder` and `AudioDecoder` support for Opus, an exact-frame capture path, AudioWorklet playout and a microphone when the participant wants to publish. Optional Audio Session, Screen Wake Lock, DTX and low-latency congestion-control results are reported separately and never represented as required support.

The configured Cloudflare isolated relay, provisioned credential and draft-16 client path are present. `MOQT_TRANSPORT_VERIFIED=false` remains authoritative: no physical Safari 27 run or reproducible browser-to-relay trace has passed, and the shared relay credential retains the documented P1 scope problem.

## 2. Standards catalogue

| Classification | Standard or API | Implementation role |
|---|---|---|
| **Required** | [QUIC RFC 9000](https://www.rfc-editor.org/info/rfc9000) | UDP-based secure multiplexed transport. |
| **Required** | [HTTP/3 RFC 9114](https://www.rfc-editor.org/info/rfc9114) and Extended CONNECT [RFC 9220](https://www.rfc-editor.org/info/rfc9220) | HTTP/3 session establishment for WebTransport. |
| **Required transport prerequisite** | HTTP Datagrams and Capsules [RFC 9297](https://www.rfc-editor.org/info/rfc9297) and QUIC DATAGRAM [RFC 9221](https://www.rfc-editor.org/info/rfc9221) | Negotiated by WebTransport-over-HTTP/3 and MOQT. Real Fabric currently carries audio objects on streams rather than its application datagram path: the adapter opens the session with `enableDatagrams: false`. |
| **Required** | [W3C WebTransport Candidate Recommendation](https://www.w3.org/TR/webtransport/) | `requireUnreliable: true` prevents a reliable-only HTTP/2/TCP first hop. The adapter also requires `reliability === "supports-unreliable"` after connection. |
| **Draft-sensitive** | [IETF WebTransport over HTTP/3 draft 16](https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/16/) | Current HTTP/3 protocol definition beneath the browser API. It is not yet an RFC. |
| **Draft-sensitive** | [IETF MOQT draft 19](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) | Current work in progress. The configured runtime remains draft 16 because `moqtail@0.12.1` and the relay frame it; draft 20 remains the product target. No wire upgrade occurs until client and relay support the same draft. |
| **Required** | [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) | Mono microphone capture with echo cancellation, noise suppression and automatic gain where exposed. |
| **Required** | [WebCodecs](https://www.w3.org/TR/webcodecs/), [Opus RFC 6716](https://www.rfc-editor.org/info/rfc6716) and the [WebCodecs Opus registration](https://w3c.github.io/webcodecs/opus_codec_registration.html) | 48 kHz mono, 32 kbit/s, 20 ms Opus encode and decode. `application: "voip"`, `signal: "voice"` and `usedtx` are retained only when `isConfigSupported()` echoes them. |
| **Required** | [Web Audio](https://www.w3.org/TR/webaudio/) | Capture worklet, output clock and one listener-side mixing worklet. |
| **Required lifecycle behaviour** | [HTML transient user activation](https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation), [Page Visibility](https://www.w3.org/TR/page-visibility-2/) and HTML `pagehide`/`pageshow` | Audio begins from a user action. Background, lock, page hide or an already-running AudioContext becoming suspended tears audio down and enters `resume_required`; returning never restarts capture automatically. |
| **Optional enhancement** | [Audio Session](https://www.w3.org/TR/audio-session/) | Requests `play-and-record` where exposed and treats `interrupted` as a named foreground-audio interruption. |
| **Optional enhancement** | [Screen Wake Lock](https://www.w3.org/TR/screen-wake-lock/) | Requested from Start/Resume, released on interruption or leave, and reported diagnostically. Denial never blocks audio. |
| **Required mobile presentation** | [CSS Environment Variables](https://www.w3.org/TR/css-env-1/) | Keeps the iPhone action rail clear of the bottom safe area. |
| **Not relied upon** | Media Session capture controls and installed Home Screen/PWA behaviour | Neither is admitted to this working-audio branch without separate non-WebRTC proof and lifecycle acceptance. |

All MOQT-version and `moqtail` compatibility code remains inside [`MoqTransportAdapter`](src/client/transport/MoqTransportAdapter.ts). The application contains no WebRTC, WebSocket-audio, HTTP/2-audio or alternative MOQT-draft fallback.

## 3. Browser and operating-system floor

The status labels describe repository behaviour, not general browser capability:

- **Supported** — every applicable real-browser, live-relay, acoustic and endurance gate passed.
- **Provisional** — code admits the configuration and runs capability gates, but physical/live acceptance remains open.
- **Read-only** — membership and inspection may work, but the client does not start live audio.
- **Unsupported** — outside the named configuration matrix.

Apple currently publishes [Safari 27](https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes) and [iOS 27](https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27-release-notes) as beta releases. The floor therefore names a test candidate, not a supported production configuration.

| Device and operating system | Browser | Repository status | Evidence still required |
|---|---|---|---|
| macOS | Chrome 141+ | **Provisional.** Existing desktop candidate. | Gate 1 trace, acoustic acceptance, capacity and two clean demo runs. |
| macOS | Top-level Safari 27+ | **Provisional.** Desktop Safari candidate. The pin names a browser major only: Safari freezes its `Mac OS X 10_15_7` token, so no macOS major can be read from the user agent and none is asserted. | Gate 1 trace, acoustic acceptance, capacity and two clean demo runs on desktop Safari. |
| macOS | Safari below 27 | **Unsupported.** Names the floor it missed, as macOS Chrome below 141 does. | Upgrade to the declared floor. |
| iPhone, iOS 27+ | Top-level Safari 27+ | **Provisional.** iOS 27/Safari 27 is the initial candidate. Later majors meet the floor but remain labelled unverified until added to the physical-device matrix. | Physical iPhone Safari 27 full-duplex run, foreground interruption/resume, trace, acoustic and endurance acceptance. |
| iPhone, iOS 27+ | Top-level Chrome for iOS 141+ | **Provisional.** Chrome for iOS is a shell around the same WebKit build Safari uses, so the iOS major carries the capability floor and the `CriOS` major names only the shell. Shared WebKit ancestry admits the browser; it is not acceptance evidence. | Physical iPhone Chrome for iOS full-duplex run, foreground interruption/resume, trace, acoustic and endurance acceptance, plus confirmation that WKWebView exposes the required WebTransport and WebCodecs surface. |
| iPhone below iOS 27, Safari 27 or Chrome 141 | Safari or Chrome for iOS | **Read-only.** | Upgrade to the declared floor; no compatibility downgrade is provided. |
| iPhone | Firefox, Edge, Opera, embedded web views or installed Home Screen mode | **Read-only.** Shared WebKit ancestry is not acceptance evidence. | Separate lifecycle and real-device scope. |
| iPadOS, Android or other narrow devices | Any browser | **Read-only.** iPadOS Safari requests desktop sites by default and reports the same Macintosh token as a Mac; `navigator.maxTouchPoints` is the only exposed difference, so a touch-capable Macintosh user agent fails closed to read-only. | Separately approved product scope and complete acceptance matrix. |
| Other desktop combinations | Any browser | **Unsupported / unverified.** | Capability implementation and the full H3 acceptance suite. |

User-agent parsing checks iPhone before Macintosh tokens, reads Safari's major version from `Version/` rather than the WebKit `Safari/` build, and fails closed when the iOS major cannot be identified. Chrome for iOS is read from `CriOS/`, which reports the shell major and carries no `Version/` token, so the engine version is never readable from it and the iOS major is the binding floor. Two further classifications follow from the same code rather than from the table: macOS Chrome below the 141 floor is **unsupported**, not read-only, because it names the floor it missed; and Edge, Opera, Brave and Samsung Internet are never accepted as Chrome, whatever Chromium version they report. Desktop Safari is admitted only when the user agent carries no Chromium or Gecko brand token and the browser exposes no `userAgentData` brands, which WebKit does not — every Chromium browser also carries a `Safari/` build token, so the `Safari/` token alone never admits a configuration.

## 4. Foreground iPhone lifecycle

1. Joining establishes room identity and control state without requesting microphone or starting MOQT.
2. **Start audio** synchronously initiates Audio Session, wake lock, AudioContext and `getUserMedia`, then revalidates the participant credential and opens MOQT.
3. Permission denial or absent hardware becomes a named listen-only state while subscriptions and the inspector remain available.
4. Visibility loss, page hide, Audio Session interruption or suspension of an already-running output context stops capture, transport, decoders and the mixer. Subscription intent and recent playback identifiers are retained.
5. Returning shows **Resume audio**. The tap revalidates identity, rebuilds the audio graph, reconnects the same MOQT draft and reconciles subscriptions without replaying retained objects.
6. Uninterrupted background calling is not promised.

## 5. Evidence and acceptance

The automated suite has **252 tests across nineteen files**. It covers the macOS Safari, iOS Safari and Chrome for iOS version floors and exclusions, HTTP/3-only constructor options, reliable-only refusal at both probe and MOQT adapter boundaries, low-latency reporting, Opus option negotiation and rejection, Audio Session and wake-lock state, explicit activation, interruption teardown, playback deduplication across resume, plus the existing Worker, room, transport, routing, audio and telemetry contracts.

Automated tests do not prove:

- WebTransport/MOQT interoperability in Safari 27;
- real bidirectional iPhone microphone and speaker behaviour;
- acoustic p50/p95 latency, route changes or audible concealment;
- the ten-minute reference composition or two clean demo runs;
- behaviour beyond the 16 MB received-data or 7,600-stream deadlock thresholds reported in [WebKit bug 319818](https://bugs.webkit.org/show_bug.cgi?id=319818);
- relay credential enforcement or expiry.

Safari 27 becomes supported only after a physical iPhone over an authorised HTTPS endpoint completes:

1. required pre-flight with `supports-unreliable` WebTransport reliability;
2. independent MOQT publication and subscriptions through the configured draft;
3. routing-control and inspector reconciliation;
4. background/lock interruption followed by explicit successful resume;
5. browser-to-relay evidence proving WebTransport over HTTP/3/QUIC and no forbidden fallback;
6. two ten-minute reference runs and a stream/byte soak that runs beyond 16 MB received and 7,600 streams without deadlock.

If any of those fail, the UI must retain the precise failure and Safari 27 remains provisional.
