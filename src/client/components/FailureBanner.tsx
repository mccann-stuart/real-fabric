import { type FailureCode, failureState } from "../../shared/failures";

const SEVERITY_PRIORITY = {
  blocking: 0,
  degraded: 1,
  transient: 2,
} as const;

/**
 * H14: every failure gets its own state, its own copy and its own recovery
 * advice. Rendering straight from the §10 registry means a failure cannot reach
 * the screen sharing another one's wording, and none of them can be silent.
 */
export function FailureBanner({
  code,
  onDismiss,
}: {
  code: FailureCode;
  onDismiss?: (code: FailureCode) => void;
}) {
  const failure = failureState(code);
  return (
    <section
      className={`failure-banner failure-banner--${failure.severity}`}
      role={failure.severity === "blocking" ? "alert" : "status"}
      data-failure={code}
    >
      <div className="failure-banner__head">
        <h3>{failure.title}</h3>
        <span className="failure-banner__severity">{failure.severity}</span>
        {onDismiss ? (
          <button
            type="button"
            onClick={() => onDismiss(code)}
            aria-label={`Dismiss ${failure.title}`}
          >
            ×
          </button>
        ) : null}
      </div>
      <p>{failure.experience}</p>
      <p className="failure-banner__behaviour">{failure.behaviour}</p>
      <p className="failure-banner__recovery">
        <b>What to do:</b> {failure.recovery}
      </p>
    </section>
  );
}

export function FailureList({
  codes,
  hiddenCodes = [],
  onDismiss,
}: {
  codes: readonly FailureCode[];
  hiddenCodes?: readonly FailureCode[];
  onDismiss?: (code: FailureCode) => void;
}) {
  const visibleCodes = prioritiseFailureCodes(codes, hiddenCodes);
  if (visibleCodes.length === 0) return null;
  const [primary, ...secondary] = visibleCodes;
  if (!primary) return null;

  return (
    <div className="failure-list">
      <FailureBanner code={primary} {...(onDismiss ? { onDismiss } : {})} />
      {secondary.length > 0 ? (
        <details className="failure-list__more">
          <summary>
            {secondary.length} more active {secondary.length === 1 ? "notice" : "notices"}
          </summary>
          <div className="failure-list__secondary">
            {secondary.map((code) => (
              <FailureBanner key={code} code={code} {...(onDismiss ? { onDismiss } : {})} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function prioritiseFailureCodes(
  codes: readonly FailureCode[],
  hiddenCodes: readonly FailureCode[] = [],
): FailureCode[] {
  const hidden = new Set(hiddenCodes);
  const unique = codes.filter((code, index) => !hidden.has(code) && codes.indexOf(code) === index);
  return unique.toSorted(
    (left, right) =>
      SEVERITY_PRIORITY[failureState(left).severity] -
      SEVERITY_PRIORITY[failureState(right).severity],
  );
}
