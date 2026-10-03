# Production 20-client synthetic audio check

The 3 October 2026 execution findings are in
[production-20-audio-load-results.md](./production-20-audio-load-results.md).

Run this against the existing `real-fabric` production Worker to measure the
reference machine's all-to-all audio behaviour. It is a bounded operational
check, not the Gate 2 acoustic loopback or venue acceptance run. Use only
generated audio, a new room, and the pinned browser on a network that passes
HTTP/3 and QUIC. Keep headphones connected if the machine's output is audible.

## Composition and gates

- One room, 20 independent human browser contexts, one microphone track per
  context, and no AI or presenter simulation. Four Chrome processes carry five
  contexts each; each process has a different generated speech-like WAV input.
  The default `turn-taking` profile speaks for three seconds in each group's
  20-second cycle and sends silence otherwise; every client speaks repeatedly
  during the hold. `--speech-profile overlap` makes every input speak
  continuously to exercise the capacity ladder's overload path.
- Ramp through 2, 5, 10, 15 and 20 participants. At each stage inspect one
  accepted publication and `N - 1` accepted subscriptions per client, increasing
  published and inbound objects, failure codes, and the capacity protection
  step. Record an incomplete stage and continue the bounded ramp unless the
  production API returns 429 or 5xx.
- Hold 20 connections for 600 seconds, then leave. The room hard-stops at
  20 minutes. A complete 20-person graph has 380 directed receive paths;
  first-object events prove an edge was observed at least once, not continuous
  delivery. The time-series counters test continuing traffic.
- Record browser exceptions, API status failures, object rates and sizes,
  receive drops, concealment, buffer occupancy, capacity steps, DTX state,
  host load, and any WebTransport byte statistics the browser exposes.
- A completed run requires 20 joined clients and the full hold. Report
  publication, subscription and first-object coverage separately. Any 429,
  failure state, browser exception, drop or capacity step is a finding to
  diagnose; none should be silently treated as a clean pass.

The room service limits joins from one client IP to 20 attempts in ten minutes.
One 20-client run uses 19 join attempts. After a failed ramp, wait for the full
rate window to clear before a same-IP retry. The browser network must also pass
WebTransport to the MoQ relay: an HTTPS health response alone does not prove
that path.

The current entry flow calls the join API again immediately after entering the
room. That duplicate first-mount call consumes a second rate event per client,
so an ordinary single-IP UI ramp is limited at about ten participants. This
harness reuses each client's successful entry response in browser memory for
that one first-mount call. Later reloads still use the real join API. The
workaround tests real browser MOQT publication and receiving, but it does not
make the normal 20-person entry flow pass; that is a separate product bug.

## Run

Use the repository's existing dependency link and an external Playwright
installation. Do not install Playwright into this production project. The
script requires an explicit production flag and does not deploy or change
Cloudflare configuration.

```sh
test -L node_modules
test "$(readlink node_modules)" = /Users/mccannstuart/.node_modules
REAL_FABRIC_PLAYWRIGHT_PATH=/path/to/external/playwright \
  node scripts/production-audio-load.mjs \
  --execute-production --clients 20 --browser-groups 4 \
  --stage-seconds 0 --hold-seconds 600
```

The ignored `output/playwright/production20/<time>/` directory contains
`client-samples.ndjson` and either `summary.json` or `partial-summary.json`.
These allow-listed files omit room codes, relay credentials, names, audio and
transcripts. Generated WAV files are deleted on exit. Do not publish raw
browser network traces: draft-16 relay credentials travel in the URL path.

## Bandwidth and Cloudflare checks

Estimate application audio payload from the difference in published or inbound
object counts times the reported mean object size, divided by the measurement
interval. Label this **estimated application payload**. It excludes MOQT and
QUIC framing, retransmissions, UDP/IP overhead, and any objects omitted from
the browser's aggregate counters. WebTransport `getStats()` byte fields can
provide browser-side on-wire figures when implemented; if absent, record
`Not exposed`. Do not substitute Worker HTTP request bytes for MoQ media bytes:
the relay carries the media outside the Worker.

Before the run, verify `wrangler whoami` and the expected account and Worker.
In the production Worker Observability view, use the run's UTC interval to
inspect persisted Workers Logs for invocation errors, 429/5xx responses,
Durable Object faults, and the structured request/correlation IDs. Its
configuration enables logs at 100% and traces at 1%; a live `wrangler tail`
stream may sample under load, so it is a diagnostic stream rather than a
complete count. Check the Cloudflare MoQ relay dashboard for any available
relay traffic counters, and label their scope and time resolution. Cloudflare
does not document a per-room MoQ bandwidth series that this script can rely
on. Never export unsanitised request URLs or token paths.

To collect the local-IP live control-plane feed without retaining room codes,
tokens or free-text log messages, run this in another terminal before the
browser test and stop it afterwards:

```sh
mkdir -p output/playwright/production20
node_modules/.bin/wrangler tail real-fabric --format json --ip self \
  | node scripts/sanitise-worker-tail.mjs \
  > output/playwright/production20/worker-tail.ndjson
```

Use the samples to identify the first membership size at which the capacity
ladder engages, inbound object rate falls behind the expected active-speaker
rate, drops or concealment rise, or browser exceptions start. Compare those
points with host load and relay/Worker errors before attributing a problem to
the application or network.

The shared relay credential remains a known P1. This test neither remedies its
scope nor establishes tenant isolation. A successful synthetic run also does
not establish acoustic latency, device parity, a venue-network clean run, or
production readiness.
