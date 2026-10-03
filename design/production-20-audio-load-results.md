# Production synthetic audio load — 3 October 2026

Target: `https://real-fabric.booms-17-brooms.workers.dev` · Cloudflare Worker
`real-fabric` · MOQT draft 16. All times below are UTC. The runs used generated
audio only; no real microphone audio or transcript was retained.

## Result

The 20-client turn-taking run entered one room and reached 20 simultaneous
accepted publications, but did **not** sustain a complete 20-person receive
graph. The 600-second hold was interrupted after 159 seconds at 20 clients
because this single 10-CPU Mac became overloaded and the clients reported
audio and transport faults. This is a measured failure of this one-host test
composition, not a measured Cloudflare relay capacity limit.

| Run | Result |
| --- | --- |
| Two-client smoke, `83723262-998e-4b06-9dac-7de71e3e007c` | Both publishers and both directed first-object receive paths observed; 10-second hold completed. |
| Continuous-overlap ramp, `d4ba78f6-796b-4544-aebe-cfaa131510df` | Nine clients published; client 10 received HTTP 429. |
| Continuous-overlap retry, `20c04b80-ee8e-43de-9b01-0789293ee659` | Ten-client stage passed initially; client 11 received HTTP 429. By the end, all ten showed `audio_behind` and capacity step 3. |
| Turn-taking ramp and hold, `119f0b90-b739-4e40-aa8f-1d48fa360230` | 20 clients joined, no API 429/5xx; stages 2, 5 and 10 fully ready; stages 15 and 20 incomplete; interrupted after 159 seconds at 20. |

The rate-limit diagnosis is source-confirmed: entry calls `/join`, then the room
hook immediately calls `/join` again with the same token. The server allows 20
join attempts per IP in ten minutes, so the ordinary UI path consumes roughly
two attempts per participant. The 20-client harness reused the initial entry
response for that one redundant first-mount call in browser memory. Later
rejoins remained real. This workaround permits a transport load measurement;
it does not fix the normal production entry flow.

## Twenty-client measurements

Run interval: 07:56:50–08:01:16; 20-client stage began 07:58:35. The browser
sampled all 20 clients at 160 time points across 159.2 seconds.

- All 20 clients showed one accepted publication at 155 of 160 time points.
- Accepted subscriptions totalled 304–376 of the possible 380, median 361.5.
  No sample showed a complete 380-edge graph.
- The bounded in-app event log exposed first objects on 224 directed paths.
  This is an observed lower bound: the log has a 200-event cap and exceptions
  can displace older events.
- Capacity step 3 appeared at 133 of 160 time points. All 20 clients showed
  `audio_behind` and `drift_uncorrectable` during the full cohort; `relay_failed`
  appeared on many clients. Browser exceptions across the entire ramp and
  hold included 277 “No subscription for received track alias”, 21 “No full
  track name for received track alias”, 485 `RESET_STREAM`, 62 “Connection
  lost”, and three terminated-session errors.
- The host one-minute load was 10.79–23.89 on a machine reporting 10 CPUs.
  This includes any unrelated host work, so it is a correlation, not CPU
  attribution to the browsers alone.
- Across the full 20-client interval, positive differences in browser object
  counters multiplied by their mean object sizes estimate **4.34 MB locally
  enqueued upstream** and **59.31 MB received downstream**. Over 159.2 seconds
  these are approximately **0.22 Mbit/s upstream** and **2.98 Mbit/s
  downstream** in aggregate application payload. They exclude MOQT/QUIC/UDP
  overhead, retransmissions, and lost or unobserved intervals. They are not
  Cloudflare relay billing or on-wire bandwidth figures.

Chrome 154 on this host exposes no `WebTransport.getStats()` method, so
browser-side on-wire bytes read `Not exposed`. The app's displayed object-rate
figures were not used for the byte estimate: its object counters persist across
transport reconnection, while the rate denominator resets at each new
`transportReadyAt`. Rates can therefore be inflated after reconnecting.

## Follow-up findings

1. Remove the redundant first-mount join without weakening real 60-second
   reclaim. Confirm a normal 20-person single-IP entry flow no longer returns
   429.
2. Investigate MOQtail received track-alias errors and WebTransport stream
   resets using a browser-to-relay trace that redacts the URL-path credential.
   Check whether subscriptions are removed while relay objects remain in
   flight, and whether reconnection restores alias maps correctly.
3. Correct the inspector's object-rate measurement across reconnections, then
   benchmark the capacity ladder and drift on distributed reference devices.
   This run's single-host browser load is not representative of 20 independent
   machines.
4. Repeat the full 600-second 20-client hold once the above faults are
   addressed or the clients are distributed. Require publication and
   subscription continuity, and separately run acoustic loopback and the venue
   acceptance script.

Cloudflare Worker and MoQ relay telemetry was **not collected** for these runs:
Wrangler still reported expired authentication. The repository configuration
specifies 100% Worker log sampling and 1% trace sampling, but that does not
verify the deployed setting or provide media relay byte counters. The
allow-listed tail sanitiser is ready for a future authenticated run.
