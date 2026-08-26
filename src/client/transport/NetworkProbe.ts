/**
 * §11.2 deliverable three: a non-blocking background reachability test for
 * HTTP/3 and QUIC, run before the room rather than discovered at join.
 *
 * The probe is deliberately draft-free. It opens a WebTransport session and
 * throws it away without exchanging a single MOQT message, so it stays outside
 * the adapter boundary and cannot become a second transport path.
 *
 * The discrimination that matters on a conference network is *which* layer
 * failed. A relay that is simply down and a network that filters UDP both look
 * like "no audio" at join. Probing the room service over TCP alongside the
 * relay over QUIC separates them, and only the second one is fixed by a phone
 * hotspot.
 */

export type ProbeState =
  | "not_run"
  | "probing"
  | "reachable"
  | "udp_blocked"
  | "endpoint_unreachable"
  | "unsupported";

export interface ProbeResult {
  state: ProbeState;
  /** Rendered verbatim in pre-flight. Never "something went wrong". */
  detail: string;
  /** The one action worth taking, or null where none is. */
  remediation: string | null;
  /** Round trip of the probe itself, not of the eventual media session. */
  elapsedMs: number | null;
}

export interface ProbeOptions {
  /** The relay this room would use. Null when none is configured. */
  relayEndpoint: string | null;
  /** A same-origin TCP/TLS control-plane URL used as the comparison leg. */
  controlPlaneUrl?: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to the platform constructor. */
  openWebTransport?: (url: string) => { ready: Promise<void>; close: () => void };
  probeControlPlane?: (url: string) => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 4_000;

export const HOTSPOT_REMEDIATION =
  "Retry once, then switch this machine to the documented phone hotspot. The build has no WebRTC or WebSocket audio fallback, so the remedy is a different network, not a different code path.";

export function notRunProbe(detail: string): ProbeResult {
  return { state: "not_run", detail, remediation: null, elapsedMs: null };
}

export async function probeRelayReachability(options: ProbeOptions): Promise<ProbeResult> {
  const {
    relayEndpoint,
    controlPlaneUrl = "/api/health",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    openWebTransport,
    probeControlPlane = defaultProbeControlPlane,
  } = options;

  if (!relayEndpoint) {
    return notRunProbe(
      "No relay endpoint is configured for the pinned draft, so there is nothing to reach.",
    );
  }
  // The capability guard covers the platform opener only. A caller that
  // supplies its own has supplied the capability with it.
  if (!openWebTransport && !("WebTransport" in globalThis)) {
    return {
      state: "unsupported",
      detail:
        "This browser does not expose WebTransport, so HTTP/3 reachability cannot be tested from here.",
      remediation: "Open the demo on the pinned browser and version named in the README.",
      elapsedMs: null,
    };
  }

  const startedAt = Date.now();
  const host = endpointHost(relayEndpoint);
  const quicReachable = await raceWithTimeout(
    openWebTransport ?? defaultOpenWebTransport,
    relayEndpoint,
    timeoutMs,
  );
  const elapsedMs = Date.now() - startedAt;

  if (quicReachable) {
    return {
      state: "reachable",
      detail: `HTTP/3 and QUIC reached ${host} in ${elapsedMs} ms. This proves the network path, not that a MOQT session succeeds.`,
      remediation: null,
      elapsedMs,
    };
  }

  const controlPlaneReachable = await probeControlPlane(controlPlaneUrl);
  if (controlPlaneReachable) {
    return {
      state: "udp_blocked",
      detail: `HTTPS reached the room service but HTTP/3 did not reach ${host} within ${timeoutMs} ms. On a venue network this is usually UDP filtering; a relay that is down looks the same from here.`,
      remediation: HOTSPOT_REMEDIATION,
      elapsedMs,
    };
  }

  return {
    state: "endpoint_unreachable",
    detail: `Neither the room service over HTTPS nor ${host} over HTTP/3 responded within ${timeoutMs} ms, so this looks like the whole connection rather than UDP alone.`,
    remediation: "Check this machine's network connection, then re-run pre-flight.",
    elapsedMs,
  };
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "the configured relay";
  }
}

async function raceWithTimeout(
  open: (url: string) => { ready: Promise<void>; close: () => void },
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  let session: { ready: Promise<void>; close: () => void };
  try {
    session = open(url);
  } catch {
    return false;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      session.ready.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // The probe never carries media, so the session is discarded either way.
    try {
      session.close();
    } catch {
      // Closing an already-failed session is expected.
    }
  }
}

function defaultOpenWebTransport(url: string): { ready: Promise<void>; close: () => void } {
  const transport = new WebTransport(url);
  return {
    ready: transport.ready,
    close: () => transport.close(),
  };
}

async function defaultProbeControlPlane(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}
