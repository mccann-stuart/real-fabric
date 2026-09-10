# Real Fabric platform standards and compatibility matrix

**Status:** Living implementation reference
**Last reconciled with code:** 10 September 2026

This document records the standards used by the current build, the exact browser and operating-system floors, and the evidence required before a configuration can be called supported. It does not authorise a transport downgrade, a production deploy or a claim that live MOQT interoperability has passed.

## 1. Current platform contract

Room membership and the control-plane WebSocket can start when the room opens. The WebSocket connection handshake transmits no query-string secrets; authentication is validated via an initial in-message `{ type: "auth" }` exchange, enforcing a maximum of one active control socket per participant (SEC-05, SEC-06). Request bodies are bounded to 32 KiB by a streaming reader (SEC-08), and room joins are rate-limited per client IP (SEC-07). Live audio starts only from an in-room **Start audio** or **Resume audio** action:

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

The configured Cloudflare isolated relay, provisioned credential and draft-16 client path are present. `MOQT_TRANSPORT_VERIFIED=false` remains authoritative: no physical Safari 27 run or reproducible browser-to-relay trace has passed, and the shared relay credential retains the documented P1 scope problem. Expired relay credentials are rejected fail-closed at the Worker boundary.

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

- **Checking** — the browser identity matches an iPhone candidate and the required local capability probes are still running.
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
| iPhone, iOS 27 target | Top-level Safari 27+ | **Provisional when every required local capability probe passes.** Safari freezes the reported iPhone OS value at an iOS 18 compatibility token, so the token is informational rather than an OS gate. Later browser majors remain unverified until added to the physical-device matrix. | Physical iPhone Safari 27 full-duplex run, foreground interruption/resume, trace, acoustic and endurance acceptance. |
| iPhone, iOS 27 target | Top-level Chrome for iOS 141+ | **Provisional when every required local capability probe passes.** Chrome for iOS is a shell around WebKit; `CriOS` identifies the shell and does not imply a Blink capability set. | Physical iPhone Chrome for iOS full-duplex run, foreground interruption/resume, trace, acoustic and endurance acceptance, plus confirmation that WKWebView exposes the required WebTransport and WebCodecs surface. |
| iPhone below Safari 27 or Chrome 141, or missing a required local capability | Safari or Chrome for iOS | **Read-only.** The exact missing browser floor or capability is named. | Upgrade the browser target or use a browser exposing the required secure-context, WebTransport, Opus, capture and playout surface; no compatibility downgrade is provided. |
| iPhone | Firefox, Edge, Opera, embedded web views or installed Home Screen mode | **Read-only.** Shared WebKit ancestry is not acceptance evidence. | Separate lifecycle and real-device scope. |
| iPadOS, Android or other narrow devices | Any browser | **Read-only.** iPadOS Safari requests desktop sites by default and reports the same Macintosh token as a Mac; `navigator.maxTouchPoints` is the only exposed difference, so a touch-capable Macintosh user agent fails closed to read-only. | Separately approved product scope and complete acceptance matrix. |
| Other desktop combinations | Any browser | **Unsupported / unverified.** | Capability implementation and the full H3 acceptance suite. |

[WebKit documents](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#update-to-ua-string) that Safari on iPhone no longer reports the current OS version and recommends feature detection instead. Real Fabric therefore parses iPhone before Macintosh tokens and uses Safari's `Version/` or Chrome for iOS's `CriOS/` only to identify the admitted top-level browser. It then runs concrete checks for secure context, WebTransport, Opus encoder and decoder configurations, AudioWorklet capture and AudioWorklet playout. Until those probes finish the UI says it is checking; a missing capability produces read-only with the exact reason, while a passing result can admit the provisional iOS 27 target even when the compatibility token says iOS 18. User-agent identity still excludes Firefox, Edge, Opera, embedded views and Home Screen mode. Desktop Safari is admitted only when the user agent carries no Chromium or Gecko brand token and the browser exposes no `userAgentData` brands, which WebKit does not — every Chromium browser also carries a `Safari/` build token, so the `Safari/` token alone never admits a configuration.

## 4. Foreground iPhone lifecycle

1. Joining establishes room identity and control state without requesting microphone or starting MOQT.
2. **Start audio** synchronously initiates Audio Session, wake lock, AudioContext and `getUserMedia`, then revalidates the participant credential and opens MOQT.
3. Permission denial or absent hardware becomes a named listen-only state while subscriptions and the inspector remain available.
4. Visibility loss, page hide, Audio Session interruption or suspension of an already-running output context stops capture, transport, decoders and the mixer. Subscription intent and recent playback identifiers are retained.
5. Returning shows **Resume audio**. The tap revalidates identity, rebuilds the audio graph, reconnects the same MOQT draft and reconciles subscriptions without replaying retained objects.
6. Uninterrupted background calling is not promised.

## 5. Evidence and acceptance

The automated suite has **281 tests across twenty files**. It covers the macOS Safari, iOS Safari and Chrome for iOS identity floors, frozen-OS-token capability admission and exclusions, HTTP/3-only constructor options, reliable-only refusal at both probe and MOQT adapter boundaries, low-latency reporting, Opus option negotiation and rejection, Audio Session and wake-lock state, explicit activation, interruption teardown, playback deduplication across resume (capped at 100 objects per group), streaming body limits, IP-based join throttling, plus the existing Worker, room, transport, routing, audio and telemetry contracts.

Automated tests do not prove:

- WebTransport/MOQT interoperability in Safari 27;
- real bidirectional iPhone microphone and speaker behaviour;
- acoustic p50/p95 latency, route changes or audible concealment;
- the ten-minute reference composition or two clean demo runs;
- behaviour beyond the 16 MB received-data or 7,600-stream deadlock thresholds reported in [WebKit bug 319818](https://bugs.webkit.org/show_bug.cgi?id=319818);
- relay credential enforcement or expiry.

## 6. Next steps and vision statements

Unachieved acceptance gates and forward-looking platform roadmap items are maintained here:

1. **Physical iPhone Safari 27 qualification criteria (Next step):** Safari 27 becomes supported only after a physical iPhone over an authorised HTTPS endpoint completes:
   - required pre-flight with `supports-unreliable` WebTransport reliability;
   - independent MOQT publication and subscriptions through the configured draft;
   - routing-control and inspector reconciliation;
   - background/lock interruption followed by explicit successful resume;
   - browser-to-relay evidence proving WebTransport over HTTP/3/QUIC and no forbidden fallback;
   - two ten-minute reference runs and a stream/byte soak that runs beyond 16 MB received and 7,600 streams without deadlock.
   If any of those fail, the UI must retain the precise failure and Safari 27 remains provisional.
2. **Physical Chrome for iOS qualification (Next step):** Verify that WKWebView within Chrome for iOS reliably exposes the required WebTransport and WebCodecs surface on physical hardware under iOS 27 without WebKit deadlock.
3. **MOQT draft 20 migration (Vision statement):** Update `MoqTransportAdapter` to negotiate MOQT draft 20 when both the client library and deployed relay support draft 20 framing, preserving identical audio and UI state.
4. **Live transport trace acceptance (Gate 1 exit):** Capture an end-to-end browser-to-relay packet and frame trace to authorise setting `MOQT_TRANSPORT_VERIFIED=true`.
5. **Acoustic loopback & endurance acceptance (Gate 2 exit):** Complete acoustic loopback latency validation (§9.4) and a 10-minute continuous run on reference hardware without drift or buffer overflow.
6. **Relay tenant-scoped authorization (Vision statement):** Implement room- and participant-scoped token validation at the relay boundary to enforce track namespaces and close the P1 credential disclosure.
