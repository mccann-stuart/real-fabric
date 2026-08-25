import { type FailureCode, failureState } from "../../shared/failures";

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
        <b>{failure.title}</b>
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
  onDismiss,
}: {
  codes: readonly FailureCode[];
  onDismiss?: (code: FailureCode) => void;
}) {
  if (codes.length === 0) return null;
  return (
    <div className="failure-list">
      {codes.map((code) => (
        <FailureBanner key={code} code={code} {...(onDismiss ? { onDismiss } : {})} />
      ))}
    </div>
  );
}
