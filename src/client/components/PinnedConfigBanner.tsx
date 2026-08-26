import {
  currentUserAgentFacts,
  describeTargets,
  matchConfiguration,
} from "../../shared/pinnedConfiguration";

/**
 * H3: anything outside the named browser, operating-system and major-version
 * candidates shows a live-audio-unavailable banner.
 *
 * Each candidate remains provisional until its applicable acceptance gates
 * pass, and the banner says so rather than implying support.
 */
export function PinnedConfigBanner() {
  const match = matchConfiguration(currentUserAgentFacts());
  if (match.status === "supported") return null;
  const provisional = match.status === "provisional";
  return (
    <section className={`pin-banner${provisional ? " pin-banner--provisional" : ""}`} role="status">
      <b>{provisional ? "Provisional audio configuration." : "Live audio unavailable here."}</b>{" "}
      <span>
        {match.reasons.join(" ")} The configured targets are {describeTargets()}.
      </span>
    </section>
  );
}

/** The same fact, stated positively, for the pre-flight page. */
export function PinnedConfigSummary() {
  const match = matchConfiguration(currentUserAgentFacts());
  return (
    <div className={`pin-summary pin-summary--${match.liveAudioEligible ? "tested" : "untested"}`}>
      <dl>
        <div>
          <dt>Audio configuration targets</dt>
          <dd>{describeTargets()}</dd>
        </div>
        <div>
          <dt>This browser</dt>
          <dd>
            {match.browser} on {match.device === "iPhone" ? "iPhone " : ""}
            {match.platform}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{configurationStatusLabel(match.status)}</dd>
        </div>
      </dl>
      <small>{match.reasons.join(" ")}</small>
    </div>
  );
}

function configurationStatusLabel(status: ReturnType<typeof matchConfiguration>["status"]): string {
  switch (status) {
    case "supported":
      return "Supported";
    case "provisional":
      return "Provisional — acceptance pending";
    case "readOnly":
      return "Read-only";
    default:
      return "Unsupported";
  }
}
