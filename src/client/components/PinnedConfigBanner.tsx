import {
  currentUserAgentFacts,
  describePin,
  matchConfiguration,
  PINNED_CONFIGURATION,
} from "../../shared/pinnedConfiguration";

/**
 * H3: anything other than the pinned browser, operating system and major
 * version shows a "not the tested configuration" banner.
 *
 * The pin is provisional until Gate 2 exit (§14), and the banner says so
 * rather than implying a decision that has not been taken.
 */
export function PinnedConfigBanner() {
  const match = matchConfiguration(currentUserAgentFacts());
  if (match.tested) return null;
  return (
    <section className="pin-banner" role="status">
      <b>Not the tested configuration.</b>{" "}
      <span>
        {match.reason} The demo is tested on {describePin()}, and behaviour here is unverified.
      </span>
      <small>{PINNED_CONFIGURATION.note}</small>
    </section>
  );
}

/** The same fact, stated positively, for the pre-flight page. */
export function PinnedConfigSummary() {
  const match = matchConfiguration(currentUserAgentFacts());
  return (
    <div className={`pin-summary pin-summary--${match.tested ? "tested" : "untested"}`}>
      <dl>
        <div>
          <dt>Tested configuration</dt>
          <dd>{describePin()}</dd>
        </div>
        <div>
          <dt>This browser</dt>
          <dd>
            {match.browser} on {match.platform}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{match.tested ? "Matches the pin" : "Not the tested configuration"}</dd>
        </div>
      </dl>
      <small>{PINNED_CONFIGURATION.note}</small>
    </div>
  );
}
