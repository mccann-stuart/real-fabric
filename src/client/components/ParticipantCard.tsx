import {
  type AiDisplayActivity,
  aiDisplayActivity,
  type Participant,
  type RoutingPreference,
} from "../../shared/contracts";

/**
 * §4.2: each card shows role, mute and speaking state, connection state and
 * live audio level. AI cards add the pipeline label and the two routing
 * toggles the viewing human owns (H9).
 */

export interface ParticipantCardProps {
  participant: Participant;
  current: boolean;
  viewerId: string;
  routing: readonly RoutingPreference[];
  connectedHumanIds: readonly string[];
  /** Live capture level for the viewer's own card, 0 to 1. */
  level?: number;
  speaking?: boolean;
  onRouting?: (aiId: string, hearsMe: boolean, iHearIt: boolean) => void;
  onAddressDown?: (aiId: string) => void;
  onAddressUp?: (aiId: string) => void;
}

export function ParticipantCard({
  participant,
  current,
  viewerId,
  routing,
  connectedHumanIds,
  level = 0,
  speaking = false,
  onRouting,
  onAddressDown,
  onAddressUp,
}: ParticipantCardProps) {
  const isAi = participant.role === "ai";
  const activity: AiDisplayActivity | "Reconnecting" | "Speaking" | "Listening" =
    participant.state === "reconnecting"
      ? "Reconnecting"
      : isAi
        ? aiDisplayActivity(participant, routing, viewerId, connectedHumanIds)
        : speaking
          ? "Speaking"
          : "Listening";

  const row = routing.find((entry) => entry.aiId === participant.id && entry.humanId === viewerId);

  return (
    <article
      className={`participant-card participant-card--${participant.role} participant-card--${slug(activity)}`}
      data-participant={participant.id}
    >
      <span className="participant-card__avatar" aria-hidden="true">
        {participant.displayName.at(0)?.toUpperCase()}
      </span>
      <div className="participant-card__identity">
        <h3>{participant.displayName}</h3>
        <p className="participant-card__labels">
          {current ? <span>You</span> : null}
          {/* §8: role must be legible at a glance, even in a dense grid. */}
          <span className={isAi ? "label label--ai" : "label label--human"}>
            {isAi ? "AI" : "Human"}
          </span>
          {participant.simulated ? <span className="label label--simulated">Simulated</span> : null}
          {isAi && participant.address ? <code>{participant.address}</code> : null}
        </p>
        <p className={`participant-card__state participant-card__state--${slug(activity)}`}>
          <i aria-hidden="true" /> {activity}
        </p>
      </div>

      <div className="waveform" aria-hidden="true">
        {current ? (
          <span
            className="waveform__level"
            style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, level))})` }}
          />
        ) : (
          // H15: another participant's level is not observable without their
          // audio, so it says so rather than drawing a decorative waveform.
          <span className="waveform__unavailable">Not exposed</span>
        )}
      </div>

      {isAi && onRouting ? (
        <div className="routing-controls">
          <Toggle
            label="Hears me"
            checked={row?.hearsMe ?? false}
            onChange={(hearsMe) => onRouting(participant.id, hearsMe, row?.iHearIt ?? true)}
          />
          <Toggle
            label="I hear it"
            checked={row?.iHearIt ?? true}
            onChange={(iHearIt) => onRouting(participant.id, row?.hearsMe ?? false, iHearIt)}
          />
          <button
            className="ask-button"
            type="button"
            onPointerDown={() => onAddressDown?.(participant.id)}
            onPointerUp={() => onAddressUp?.(participant.id)}
            onPointerLeave={() => onAddressUp?.(participant.id)}
          >
            Hold to ask {participant.displayName}
          </button>
          {/* FR8: say which form is in effect rather than implying a guarantee
              the transport is not providing. */}
          <small className={`enforcement enforcement--${row?.enforcement ?? "cooperative"}`}>
            {row?.enforcement === "enforced"
              ? "Enforced at the relay by credential scope"
              : "Cooperative — the AI unsubscribes on request; the relay does not enforce it"}
          </small>
        </div>
      ) : null}
    </article>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  );
}

function slug(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "-");
}
