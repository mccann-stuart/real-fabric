# Real Fabric

> People and AIs speaking over Media over QUIC.

Real Fabric is a ten-minute conference-stage demonstration. Humans publish independent audio tracks while the audience can inspect relay fan-out, subscriptions, routing changes and failure states. Scripted AI participants are visibly simulated today; independent AI audio tracks are a Milestone 3 goal. The [product specification](design/PRODUCT_SPEC_v1-demo_1.md) defines the requirements, and [AGENTS.md](AGENTS.md) records repository rules and the current implementation boundary.

## Current state

The React/Vite client, SQLite Durable Object room service, control-plane WebSocket, presenter simulation, browser audio pipeline, inspector, telemetry and failure registry are implemented. The latest recorded suite has 447 automated tests across 27 files. The inspector exposes actual publication and accepted subscriptions, with unavailable measurements shown as **Not exposed** and partial figures as **Reported · no gate**.

Gate 1 transport acceptance passed on 10 September 2026: a browser-to-relay trace proved draft-16 MOQT negotiation, publication and subscription over WebTransport and HTTP/3/QUIC with 0.0% loss in the sampled frame exchange. Evidence is in the local `reports/gate1-transport-trace.json` and `reports/gate1-transport.netlog`; `wrangler.jsonc` sets `MOQT_TRANSPORT_VERIFIED=true`. This does not qualify draft 20, Safari, acoustic latency or the full demo run. Presenter AI responses remain scripted and labelled; there is no live recognition, model, synthesis or AI-worker audio pipeline.

The configured Cloudflare relay uses `moqtail@0.12.1` and MOQT draft 16. The adapter attempts only the configured draft; it does not fall back to another draft, WebRTC or WebSocket audio. A missing, malformed or expired relay credential produces a named failure before audio transport starts. The production relay token last observed on 9 September 2026 was expired. `/api/health` exposes only non-secret credential status.

### Known P1: shared relay credential

Unauthenticated room creation and open room joining return the locally current `MOQ_RELAY_TOKEN` to the browser. It grants publish and subscribe across the whole relay and can be reused outside the room service until expiry or revocation. Cloudflare's current V1 MoQ tokens cannot enforce room, namespace, track or participant scope; labels are metadata and the ten-token-per-relay limit conflicts with open membership. Token rotation or a distinct relay per room does not fully enforce participant namespaces. Treat this as unresolved: do not use the shared-relay path for sensitive audio or claim tenant isolation or relay-enforced routing. See [SEC-01](security/security_issues.md#sec-01--room-creation-and-joining-disclose-a-relay-wide-publishsubscribe-bearer).

Other recorded security findings are tracked in [security issues](security/security_issues.md). SEC-02 and SEC-04–SEC-12 have code and automated-test mitigations; SEC-03 is partial because an AI-bound turn lease is missing, and SEC-13 remains open. The security scan's canonical evidence is retained in `security/findings.json`, `security/coverage.json` and `security/scan-manifest.json`.

## Platform and media contract

Room entry establishes membership and control state. **Start audio** and **Resume audio** initiate capture, AudioContext activation and MOQT from a user action. Permission denial or missing hardware enters a visible listen-only state. Backgrounding, locking, hiding the page or an already-running AudioContext suspension tears audio down to `resume_required`; capture never restarts automatically.

```text
microphone → mono 960-sample frames → WebCodecs Opus encoder
  → MoqTransportAdapter → MOQT objects over WebTransport/HTTP/3/QUIC → relay
  → one decoder and bounded jitter buffer per remote track
  → one listener-side AudioWorklet mixer and output clock
```

`MediaStreamTrackProcessor` is the preferred Chrome capture path; an exact-frame AudioWorklet path serves browsers without it. Capture requests echo cancellation, noise suppression and automatic gain where available. Opus is 48 kHz mono at 32 kbit/s in 20 ms frames; DTX is used only if the encoder exposes it. Audio Session, Screen Wake Lock, DTX and low-latency congestion control are optional diagnostics, not support gates. `MoqTransportAdapter` contains all MOQT-version and library compatibility code.

| Standard or API | Role in this build |
|---|---|
| [QUIC RFC 9000](https://www.rfc-editor.org/info/rfc9000), [HTTP/3 RFC 9114](https://www.rfc-editor.org/info/rfc9114), [Extended CONNECT RFC 9220](https://www.rfc-editor.org/info/rfc9220) | Required UDP-capable transport beneath WebTransport. |
| [HTTP Datagrams and Capsules RFC 9297](https://www.rfc-editor.org/info/rfc9297), [QUIC DATAGRAM RFC 9221](https://www.rfc-editor.org/info/rfc9221) | WebTransport prerequisites; Real Fabric audio objects currently use streams and the adapter sets `enableDatagrams: false`. |
| [WebTransport](https://www.w3.org/TR/webtransport/), [WebTransport over HTTP/3 draft 16](https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/16/) | The client requires `requireUnreliable: true` and then `reliability === "supports-unreliable"`; a reliable-only HTTP/2/TCP first hop is refused. |
| [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/), [Web Audio](https://www.w3.org/TR/webaudio/) | Microphone capture, exact frames, output clock and listener-side mixing. |
| [WebCodecs](https://www.w3.org/TR/webcodecs/), [Opus RFC 6716](https://www.rfc-editor.org/info/rfc6716), [Opus registration](https://w3c.github.io/webcodecs/opus_codec_registration.html) | Opus encode/decode; optional `application`, `signal` and `usedtx` settings are retained only when `isConfigSupported()` echoes them. |
| [HTML user activation](https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation), [Page Visibility](https://www.w3.org/TR/page-visibility-2/), `pagehide`/`pageshow` | Explicit foreground Start/Resume and interruption teardown. |
| [Audio Session](https://www.w3.org/TR/audio-session/), [Screen Wake Lock](https://www.w3.org/TR/screen-wake-lock/) | Optional foreground hints; wake-lock denial does not block audio. |
| [CSS Environment Variables](https://www.w3.org/TR/css-env-1/) | Keep the iPhone action rail clear of the safe area. |

Media Session capture controls and installed Home Screen mode are not admitted to working audio without separate lifecycle acceptance. The app contains no audio fallback over WebRTC, WebSocket or HTTP/2.

## Browser and operating-system matrix

**Provisional** means the client recognises the configuration and runs local capability gates, while real-browser acceptance remains open. **Read-only** permits membership and inspection without capture. **Supported** requires the applicable live relay, acoustic, endurance and demo-run evidence; no row below has that status yet.

| Device | Browser | Current behaviour | Remaining evidence |
|---|---|---|---|
| macOS | Chrome 141+ | Provisional desktop candidate. | Full real-browser suite, acoustic and endurance acceptance. |
| macOS | Top-level Safari 27+ | Provisional desktop candidate. The `Mac OS X 10_15_7` user-agent token is frozen and does not prove a macOS major. | Safari-specific transport, capture, acoustic and endurance acceptance. |
| macOS | Chrome below 141 or Safari below 27 | Unsupported; names the missed browser floor. | Upgrade to the declared floor. |
| iPhone on the iOS 27 target | Top-level Safari 27+ | Provisional after all required capability probes pass. The frozen iOS 18 token is informational. | Physical full-duplex, interruption/resume, trace, acoustic and endurance runs. |
| iPhone on the iOS 27 target | Top-level Chrome for iOS 141+ | Provisional after all required capability probes pass; `CriOS` identifies a WebKit shell, not Blink capability. | Physical WKWebView WebTransport/WebCodecs, full-duplex, interruption/resume, trace, acoustic and endurance runs. |
| iPhone | Older Safari/Chrome or a missing required capability | Read-only with the exact reason. | Browser floor and secure-context, WebTransport, Opus, capture and playout probes. |
| iPhone | Firefox, Edge, Opera, embedded views or installed Home Screen mode | Read-only. | Separately approved lifecycle and real-device scope. |
| iPadOS, Android or other narrow devices | Any browser | Read-only. iPadOS desktop mode is distinguished from macOS by `navigator.maxTouchPoints`. | Separate product scope and acceptance matrix. |
| Other desktop combinations | Any browser | Unsupported or unverified. | Capability implementation and the full H3 suite. |

The iPhone classifier uses `Version/` or `CriOS/` to identify the top-level browser, then probes secure context, WebTransport, Opus encode/decode, AudioWorklet capture and playout. A probe still in progress reads **Checking**; a failure names the missing capability. Chromium's `Safari/` build token never admits it as Safari. [WebKit's user-agent guidance](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#update-to-ua-string) explains why the frozen OS token is not an audio veto.

On iPhone, returning from an interruption requires an explicit **Resume audio** tap. It revalidates identity, rebuilds the audio graph and subscriptions, and avoids replaying retained objects. Uninterrupted background calling is not promised.

### Measured capacity

**Not yet measured.** The room has no configured participant cap. The degradation ladder is implemented and unit-tested, but the participant counts at which its steps engage on reference hardware and network are unknown. Its synthetic triggers are implementation rules, not capacity measurements. The [roadmap](design/ROADMAP.md) records the benchmark and acceptance work.

## Local setup and verification

The canonical checkout is OneDrive-backed. Keep the physical dependency tree at `/Users/mccannstuart/.node_modules`, with `node_modules` in each checkout as a symlink to that exact directory. If the external directory exists and a checkout lacks only the link, create it with `ln -s /Users/mccannstuart/.node_modules node_modules`. Do not replace a physical directory or differing external data without inspection.

```sh
test -L node_modules
test "$(readlink node_modules)" = "/Users/mccannstuart/.node_modules"
test "$(realpath node_modules)" = "/Users/mccannstuart/.node_modules"
pnpm install --frozen-lockfile --modules-dir /Users/mccannstuart/.node_modules
```

Use the pinned pnpm 11.22.0 and recheck the link after dependency changes. Never use `npm install` here. For development and the complete local gate:

```sh
pnpm dev
pnpm check
```

`pnpm check` runs lint, typecheck, tests, build and Wrangler deploy dry run. `WORKERS_CI=1` invokes the guarded build hook for Cloudflare Workers Builds; local installation does not. Browser acceptance and production deployment are separate activities and require the evidence and authority in [AGENTS.md](AGENTS.md).

## Documentation map and next work

- [Product specification](design/PRODUCT_SPEC_v1-demo_1.md) — binding product requirements, H1–H16, failure states and release gates.
- [Roadmap](design/ROADMAP.md) — outstanding gates, physical browser qualification, security fixes and deferred engineering ideas.
- [Milestone 3 plan](design/plan-milestone-3-optimized-kernighan.md) — detailed, forward-looking AI floor and audio proposal; recheck its source line references before implementation.
- [Security issues](security/security_issues.md) — finding-level remediation status and verification criteria, backed by the retained scan JSON.
- [Repository instructions](AGENTS.md) — current implementation snapshot, dependency discipline and Git/Cloudflare boundaries.

No audio or transcript content is retained. Production deployment, relay changes and credential rotation require separate, explicit authorisation.
