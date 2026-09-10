import { useEffect, useState } from "react";
import {
  type BrowserCapabilityEvidence,
  currentUserAgentFacts,
  matchConfiguration,
} from "../../shared/pinnedConfiguration";
import { evaluateRequiredBrowserCapabilities } from "./useCapabilities";

const CHECKING_CAPABILITIES: BrowserCapabilityEvidence = {
  state: "checking",
  missing: [],
};

/**
 * Resolves H3 from browser identity plus concrete local capability probes.
 * Safari deliberately freezes its iPhone OS user-agent token, so the token is
 * never allowed to overrule observed WebTransport, Opus, capture and playout.
 */
export function usePinnedConfiguration() {
  const [facts] = useState(currentUserAgentFacts);
  const [capabilities, setCapabilities] =
    useState<BrowserCapabilityEvidence>(CHECKING_CAPABILITIES);

  useEffect(() => {
    let active = true;
    void evaluateRequiredBrowserCapabilities()
      .then((evidence) => {
        if (active) setCapabilities(evidence);
      })
      .catch(() => {
        if (active) {
          setCapabilities({
            state: "unavailable",
            missing: ["the browser capability probe did not complete"],
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return matchConfiguration(facts, capabilities);
}
