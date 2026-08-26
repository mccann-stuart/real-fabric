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
  | "reliable_only"
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
  /** W3C WebTransport first-hop reliability after the session is ready. */
  reliability: "supports-unreliable" | "reliable-only" | "pending" | "Not exposed";
  /** Effective browser value, which may be default even when low latency was requested. */
  congestionControl: "low-latency" | "throughput" | "default" | "Not exposed";
}

export interface ProbeTransport {
  ready: Promise<void>;
  close: () => void;
  reliability?: "supports-unreliable" | "reliable-only" | "pending" | undefined;
  congestionControl?: "low-latency" | "throughput" | "default" | undefined;
}

export interface ProbeOptions {
  /** The relay this room would use. Null when none is configured. */
  relayEndpoint: string | null;
  /** A same-origin TCP/TLS control-plane URL used as the comparison leg. */
  controlPlaneUrl?: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to the platform constructor. */
  openWebTransport?: (url: string) => ProbeTransport;
  probeControlPlane?: (url: string) => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 4_000;

export const HOTSPOT_REMEDIATION =
  "Retry once, then switch this machine to the documented phone hotspot. The build has no WebRTC or WebSocket audio fallback, so the remedy is a different network, not a different code path.";

export function notRunProbe(detail: string): ProbeResult {
  return {
    state: "not_run",
    detail,
    remediation: null,
    elapsedMs: null,
    reliability: "Not exposed",
    congestionControl: "Not exposed",
  };
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
      reliability: "Not exposed",
      congestionControl: "Not exposed",
    };
  }

  const startedAt = Date.now();
  const host = endpointHost(relayEndpoint);
  const transport = await raceWithTimeout(
    openWebTransport ?? defaultOpenWebTransport,
    relayEndpoint,
    timeoutMs,
  );
  const elapsedMs = Date.now() - startedAt;

  if (transport.reachable && transport.reliability === "reliable-only") {
    return {
      state: "reliable_only",
      detail: `${host} accepted WebTransport over a reliable-only first hop. Real Fabric requires UDP-capable HTTP/3 and will not carry audio over HTTP/2 or TCP.`,
      remediation: HOTSPOT_REMEDIATION,
      elapsedMs,
      reliability: transport.reliability,
      congestionControl: transport.congestionControl,
    };
  }

  if (transport.reachable) {
    const congestion =
      transport.congestionControl === "Not exposed"
        ? "effective congestion control was not exposed"
        : `effective congestion control ${transport.congestionControl}`;
    return {
      state: "reachable",
      detail: `HTTP/3 and QUIC reached ${host} in ${elapsedMs} ms with ${transport.reliability === "supports-unreliable" ? "UDP-capable" : "unreported"} WebTransport reliability; ${congestion}. This proves the network path, not that a MOQT session succeeds.`,
      remediation: null,
      elapsedMs,
      reliability: transport.reliability,
      congestionControl: transport.congestionControl,
    };
  }

  const controlPlaneReachable = await probeControlPlane(controlPlaneUrl);
  if (controlPlaneReachable) {
    return {
      state: "udp_blocked",
      detail: `HTTPS reached the room service but HTTP/3 did not reach ${host} within ${timeoutMs} ms. On a venue network this is usually UDP filtering; a relay that is down looks the same from here.`,
      remediation: HOTSPOT_REMEDIATION,
      elapsedMs,
      reliability: transport.reliability,
      congestionControl: transport.congestionControl,
    };
  }

  return {
    state: "endpoint_unreachable",
    detail: `Neither the room service over HTTPS nor ${host} over HTTP/3 responded within ${timeoutMs} ms, so this looks like the whole connection rather than UDP alone.`,
    remediation: "Check this machine's network connection, then re-run pre-flight.",
    elapsedMs,
    reliability: transport.reliability,
    congestionControl: transport.congestionControl,
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
  open: (url: string) => ProbeTransport,
  url: string,
  timeoutMs: number,
): Promise<{
  reachable: boolean;
  reliability: ProbeResult["reliability"];
  congestionControl: ProbeResult["congestionControl"];
}> {
  let session: ProbeTransport;
  try {
    session = open(url);
  } catch {
    return {
      reachable: false,
      reliability: "Not exposed",
      congestionControl: "Not exposed",
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reachable = await Promise.race([
      session.ready.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    return {
      reachable,
      reliability: reachable ? (session.reliability ?? "Not exposed") : "Not exposed",
      congestionControl: reachable ? (session.congestionControl ?? "Not exposed") : "Not exposed",
    };
  } catch {
    return {
      reachable: false,
      reliability: "Not exposed",
      congestionControl: "Not exposed",
    };
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

function defaultOpenWebTransport(url: string): ProbeTransport {
  const transport = new WebTransport(url, {
    requireUnreliable: true,
    congestionControl: "low-latency",
  });
  const diagnostics = transport as WebTransport & {
    reliability?: ProbeTransport["reliability"];
    congestionControl?: ProbeTransport["congestionControl"];
  };
  return {
    ready: transport.ready,
    close: () => transport.close(),
    // These values change from pending/default during connection setup. Read
    // them only after `ready` rather than copying the constructor-time value.
    get reliability() {
      return diagnostics.reliability;
    },
    get congestionControl() {
      return diagnostics.congestionControl;
    },
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
