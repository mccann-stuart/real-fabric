# Real Fabric roadmap and acceptance backlog

**Reconciled:** 30 September 2026. This is forward-looking work, not a claim that a live gate has passed. The [product specification](PRODUCT_SPEC_v1-demo_1.md) remains binding; [AGENTS.md](../AGENTS.md) records the current implementation snapshot. The [Milestone 3 plan](plan-milestone-3-optimized-kernighan.md) is a detailed proposal whose source line references must be rechecked before implementation.

Gate 1 draft-16 transport acceptance passed on 10 September 2026 with browser-to-relay packet and frame evidence. It does not clear the shared relay credential P1, draft 20, acoustic or device acceptance. The remaining work is ordered by the live demonstration's dependencies.

## 1. Relay and protocol boundary

1. **MOQT draft 20 migration — next step when available.** Upgrade the exactly pinned `moqtail` only when it can frame draft 20 and the configured relay supports the same draft. Update the Worker endpoint and `MoqTransportAdapter`; keep room semantics, UI state and the audio pipeline unchanged. Refuse an unavailable draft by name and never downgrade silently. A new browser-to-relay trace must prove negotiation, publication and subscription before draft-20 transport is called verified.
2. **Relay-scoped authorisation — unresolved P1.** Replace the shared relay-wide bearer with relay-enforced room *and* participant namespace permissions without a participant-count cap. Cloudflare V1 token labels, application claims, client checks, rotation and coarse per-client tokens do not meet this gate. Prove cross-room and cross-participant denial with live negative traces before changing the cooperative routing label or claiming tenant isolation. Until then, the shared credential remains an unresolved disclosure; see [SEC-01](../security/security_issues.md#sec-01--room-creation-and-joining-disclose-a-relay-wide-publishsubscribe-bearer).
3. **Operational probes — next step.** Record a live UDP-capable WebTransport `NetworkProbe` result and relay credential acceptance/expiry behaviour. The existing draft-free probe and Worker JWT `exp` check are code features, not a browser result or relay-side signature proof.

## 2. Audio and capacity acceptance

1. **Gate 2 acoustic loopback.** Measure microphone-to-speaker latency with the specification's §9.4 method and compare complete observations with §9.3 budgets. Listen to packet-loss concealment and route changes; unit tests do not establish audible quality.
2. **Ten-minute reference run.** Run the full §9.1 composition on reference hardware without drift artefacts, buffer overflow or an inaudible failure. Record the hardware, network, timing and failure evidence.
3. **Measured capacity.** Benchmark the degradation ladder on reference hardware and report the participant count at the first and third degradation steps, with network conditions. Membership stays open; the result describes measured capacity rather than a configured join cap.
4. **AudioWorklet parity.** Test the fallback capture path in real Safari and Chrome for iOS, including exact frames and acoustic parity with the `MediaStreamTrackProcessor` path. Current path-selection and framing unit tests are insufficient.
5. **Reaccept the consolidated audio path.** PR #243's local browser run had no usable relay credential, so it did not reaccept live audio or the changed mixer and concealment path. Run browser-to-relay audio, acoustic loopback and endurance checks with an authorised usable credential and reference devices before claiming acceptance for that head. The earlier Gate 1 trace verifies the pre-existing transport boundary only.

## 3. Milestone 3: AI floor and audio

The application currently has labelled presenter simulation, local `AiDirector` logic and receive-side cancellation. It has no live speech provider or AI MOQT publication. The [implementation plan](plan-milestone-3-optimized-kernighan.md) proposes the following work:

1. Bind Durable Object floor grants and releases to a short-lived lease for the current AI. Reject stale or wrong-AI releases and prove concurrent request, departure and reconnect ordering. This closes the remaining SEC-03 authority gap.
2. Publish one independent, unmistakably labelled synthetic-voice track per scripted AI. Emit publisher-side barge-in cancellation and end-of-turn markers; verify queued receiver objects stop audibly within 300 ms. Faults must close only the affected AI publication and leave human audio and other AIs running.
3. Define interfaces for recognition, model and synthesis timings and live providers while keeping provider choice and wake-name detection explicit open decisions. Do not present the scripted responder as a live AI pipeline or label cooperative inbound routing as enforced.
4. Test AI loops, a hard turn cap, no default AI-to-AI subscription and all named §10 failure states. Gate 3 still needs real audible acceptance after the code work.

## 4. Browser and venue acceptance

The exact provisional browser/OS matrix is in the [README](../README.md#browser-and-operating-system-matrix). No candidate is fully supported until its applicable physical and acoustic evidence exists.

- **iPhone Safari 27+ on the iOS 27 target.** On a physical device and authorised HTTPS endpoint, pass required pre-flight including `supports-unreliable` WebTransport, independent MOQT publish/subscribe, routing and inspector reconciliation, background/lock interruption followed by explicit Resume, and a browser-to-relay HTTP/3/QUIC trace without fallback. Run two ten-minute reference compositions and a soak beyond the 16 MB received-data and 7,600-stream thresholds reported in [WebKit bug 319818](https://bugs.webkit.org/show_bug.cgi?id=319818). Keep the exact failure visible and the row provisional if any test fails.
- **Chrome for iOS 141+ on the iOS 27 target.** Confirm physical WKWebView exposes and sustains WebTransport and WebCodecs, then run the same full-duplex, foreground interruption, trace, acoustic and endurance suite. The `CriOS` token alone proves no media capability.
- **Desktop Chrome 141+ and Safari 27+ on macOS.** Complete the applicable real-browser entry, pre-flight, create/join/leave/rejoin, presenter, per-AI routing, inspector, failure and audio suite. Retain the exact provisional label until physical and acoustic evidence is recorded.
- **Gate 4 venue validation.** Complete two clean full runs of the specification's §12 demonstration script on a venue network or mobile hotspot. Keep the proof separate from unit tests and the Gate 1 trace.

## 5. Security and deferred engineering work

- **SEC-13 activity integrity.** Decide whether shared recency means membership activity or observed speech. The current API rejects another participant's target ID, but self-reported activity does not prove speech; `RoomSession` can also report the viewer active when a remote first object arrives. For speech, derive display state from each listener's observed media or a trusted relay event, then test the chosen meaning and rate limits. See the [security backlog](../security/security_issues.md#sec-13--any-participant-can-spoof-another-participants-activity).
- **Mixer regression coverage.** Add a lasting test that executes the actual `mixer-worklet.js` source for ring wrap, writes longer than the 48,000-sample ring and mixed output. PR #243 used an ad hoc Node VM comparison, but no source-level CI regression protects that case yet.
- **Performance candidates.** Measure before adopting zero-copy WebCodecs-to-WebTransport writes, a dedicated worker for jitter/PLC/decode scheduling, or further allocation removal in AudioWorklet capture and mixer buffers. The current capture path already uses a bounded transferable-buffer pool; these remain proposals, not measured improvements.
- **Accessibility beyond v1.** The subscription graph now has an expandable participant table. A further hierarchical graph alternative may be explored only if the current table fails the relevant keyboard or screen-reader task. Captions and transcript display are outside v1; a future design must meet WCAG 2.2 AA without obscuring participant cards or inspector telemetry and must revisit the no-retention rule explicitly.
- **Deferred PR ideas from the 30 September 2026 reviews.** Reconsider two-year HSTS with `includeSubDomains` and `preload` only after every production subdomain and future route is validated. Revisit drift-estimator, RMS, parse and eviction micro-optimisations only with reference-hardware benchmarks and acoustic evidence; do not change accepted track strings as a performance shortcut. The PR disposition and unactioned-finding reviews remain in Git history.

When an item is implemented, update this roadmap, the README and AGENTS.md with the exact boundary verified. A passing unit test does not turn a live acceptance item into a completed gate.
