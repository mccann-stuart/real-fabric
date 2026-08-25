/**
 * H14: every failure in specification §10 has a distinct, non-silent state.
 *
 * One registry, one entry per §10 row. The UI renders from this table so a new
 * failure cannot arrive without copy, and no failure can share another's
 * wording — which is how a silent fallback usually gets in.
 */

export type FailureCode =
  | "transport_unsupported"
  | "udp_blocked"
  | "microphone_denied"
  | "microphone_no_device"
  | "draft_mismatch"
  | "draft_endpoint_missing"
  | "namespace_discovery_unavailable"
  | "participant_disconnected"
  | "reloading"
  | "ai_pipeline_failed"
  | "ai_floor_contention"
  | "ai_loop_capped"
  | "relay_failed"
  | "beyond_measured_capacity"
  | "audio_behind"
  | "drift_uncorrectable";

export type FailureSeverity = "blocking" | "degraded" | "transient";

export interface FailureState {
  code: FailureCode;
  /** Short title. Names the specific missing capability, never "something went wrong". */
  title: string;
  /** What the user is told. §10 "user experience" column. */
  experience: string;
  /** What the build does. §10 "behaviour" column. */
  behaviour: string;
  /** The one action worth taking. */
  recovery: string;
  severity: FailureSeverity;
  /** True where the failure stops live audio outright. */
  blocksPublication: boolean;
}

const REGISTRY: Record<FailureCode, FailureState> = {
  transport_unsupported: {
    code: "transport_unsupported",
    title: "WebTransport or Opus encode unsupported",
    experience:
      "This browser does not expose the capability named in the pre-flight panel, so there is no way to publish audio.",
    behaviour: "No join and no fallback. The build contains no WebRTC or WebSocket audio path.",
    recovery: "Open the demo on the pinned browser and version named in the README.",
    severity: "blocking",
    blocksPublication: true,
  },
  udp_blocked: {
    code: "udp_blocked",
    title: "HTTP/3 or UDP blocked",
    experience:
      "The relay could not be reached over HTTP/3 and QUIC. The network is filtering UDP.",
    behaviour: "The partial session is closed. No transport substitution is attempted.",
    recovery:
      "Retry once, then switch to a phone hotspot. The fallback is a network, not a code path.",
    severity: "blocking",
    blocksPublication: true,
  },
  microphone_denied: {
    code: "microphone_denied",
    title: "Microphone permission denied",
    experience: "Listening and inspection continue. Nothing is published from this browser.",
    behaviour: "Publication stays closed. Subscriptions and the inspector are unaffected.",
    recovery:
      "Grant microphone access in the browser site settings, then run the microphone test again.",
    severity: "degraded",
    blocksPublication: true,
  },
  microphone_no_device: {
    code: "microphone_no_device",
    title: "No microphone input device",
    experience: "No capture device was found. Listening and inspection continue.",
    behaviour: "Publication stays closed. Subscriptions and the inspector are unaffected.",
    recovery: "Connect a microphone or headset, then run the microphone test again.",
    severity: "degraded",
    blocksPublication: true,
  },
  draft_mismatch: {
    code: "draft_mismatch",
    title: "MOQT draft mismatch",
    experience:
      "The local draft and the relay's draft differ. Both versions are named in the error.",
    behaviour: "The session stops before publishing. The draft is never silently downgraded.",
    recovery: "Point the build at a relay endpoint serving the pinned draft.",
    severity: "blocking",
    blocksPublication: true,
  },
  draft_endpoint_missing: {
    code: "draft_endpoint_missing",
    title: "No relay endpoint for the pinned draft",
    experience:
      "The pinned MOQT draft has no deployed relay endpoint, so live audio cannot start. This is reported at startup, not at join.",
    behaviour:
      "Room membership, routing, inspection and presenter simulation stay available. The draft is never downgraded to reach a relay that exists.",
    recovery:
      "Escalate per specification §2.1. Presenter simulation demonstrates the room without claiming transport.",
    severity: "blocking",
    blocksPublication: true,
  },
  namespace_discovery_unavailable: {
    code: "namespace_discovery_unavailable",
    title: "SUBSCRIBE_NAMESPACE unavailable",
    experience: "Membership still works. The inspector states which discovery mechanism is in use.",
    behaviour:
      "Discovery falls back to the room service control channel. Audio object arrival remains the source of truth for connected.",
    recovery: "None required. Record the endpoint's capability against Gate 1 output four.",
    severity: "degraded",
    blocksPublication: false,
  },
  participant_disconnected: {
    code: "participant_disconnected",
    title: "Participant disconnected",
    experience: "That participant shows Reconnecting, then Left. Everyone else is unaffected.",
    behaviour:
      "All other tracks continue. Any AI subscribed to the missing track suspends rather than answering on partial audio.",
    recovery: "None required. The rejoin window is 60 seconds.",
    severity: "transient",
    blocksPublication: false,
  },
  reloading: {
    code: "reloading",
    title: "Reconnecting after reload",
    experience: "A brief reconnecting state, then the same identity and routing.",
    behaviour:
      "The single-use rejoin token restores identity and the routing matrix within 60 seconds. Playback is deduplicated so nothing plays twice.",
    recovery: "None required.",
    severity: "transient",
    blocksPublication: false,
  },
  ai_pipeline_failed: {
    code: "ai_pipeline_failed",
    title: "AI pipeline unavailable",
    experience: "That AI shows Unavailable. Every other participant is unaffected.",
    behaviour: "The AI's publication closes. Human tracks and other AIs continue.",
    recovery: "Use the presenter's scripted responses, which are labelled as scripted.",
    severity: "degraded",
    blocksPublication: false,
  },
  ai_floor_contention: {
    code: "ai_floor_contention",
    title: "AI floor contention",
    experience: "The second addressed AI shows Thinking, then speaks. Speech never overlaps.",
    behaviour: "Floor control serialises AI publication. Concurrent AI speech is off by default.",
    recovery: "None required.",
    severity: "transient",
    blocksPublication: false,
  },
  ai_loop_capped: {
    code: "ai_loop_capped",
    title: "AI-to-AI turn cap reached",
    experience: "The turn counter is visible and the exchange stops at the cap.",
    behaviour:
      "AI-to-AI subscription is off by default and hard-capped when a presenter enables it.",
    recovery: "Address an AI directly to resume, or disable AI-to-AI routing.",
    severity: "degraded",
    blocksPublication: false,
  },
  relay_failed: {
    code: "relay_failed",
    title: "Relay session failed",
    experience: "The room shows Reconnecting with a bounded retry and a visible attempt count.",
    behaviour:
      "Publications, subscriptions and the routing matrix are restored idempotently. A terminal error with a retry action appears after 30 seconds.",
    recovery: "Wait for the bounded retry, then use the retry action if it becomes terminal.",
    severity: "transient",
    blocksPublication: true,
  },
  beyond_measured_capacity: {
    code: "beyond_measured_capacity",
    title: "Beyond measured capacity",
    experience: "The engaged degradation step is named in the room. No join is ever refused.",
    behaviour:
      "The ladder raises the nominal buffer, releases decoders for long-silent tracks, then unsubscribes the least recently active participants.",
    recovery: "None required. The ladder recovers as the active speaker count drops.",
    severity: "degraded",
    blocksPublication: false,
  },
  audio_behind: {
    code: "audio_behind",
    title: "Audio falling behind",
    experience: "A quality warning with the late-drop count for the affected track.",
    behaviour:
      "Stale objects are dropped and counted, loss is concealed with Opus packet loss concealment, and latency stays bounded.",
    recovery: "None required. Sustained loss produces comfort noise rather than silence.",
    severity: "degraded",
    blocksPublication: false,
  },
  drift_uncorrectable: {
    code: "drift_uncorrectable",
    title: "Clock drift beyond correction range",
    experience: "A quality warning on the affected track only.",
    behaviour: "That track's buffer is rebuilt at the next detected silence.",
    recovery: "None required.",
    severity: "degraded",
    blocksPublication: false,
  },
};

export function failureState(code: FailureCode): FailureState {
  return REGISTRY[code];
}

export const ALL_FAILURE_CODES = Object.keys(REGISTRY) as FailureCode[];

export function allFailureStates(): FailureState[] {
  return ALL_FAILURE_CODES.map(failureState);
}
