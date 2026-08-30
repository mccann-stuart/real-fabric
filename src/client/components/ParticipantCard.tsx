import {
  type AiDisplayActivity,
  aiDisplayActivity,
  type Participant,
  type RoutingPreference,
} from "../../shared/contracts";
import type { TrackSubscriptionState } from "../session/RoomSession";

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
  subscription?: TrackSubscriptionState | undefined;
  onSubscription?: ((participantId: string, enabled: boolean) => void) | undefined;
  onRouting?: (aiId: string, hearsMe: boolean, iHearIt: boolean) => void;
  isAddressing?: boolean;
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
  subscription,
  onSubscription,
  onRouting,
  isAddressing = false,
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
  const subscriptionControl =
    !current && !participant.simulated && subscription && onSubscription ? (
      <div className="track-controls">
        <Toggle
          label={isAi ? "I hear it" : "I hear them"}
          ariaLabel={`${isAi ? "I hear it" : "I hear them"} (${participant.displayName})`}
          checked={subscription.intent}
          onChange={(enabled) => onSubscription(participant.id, enabled)}
        />
        <small
          className={`track-status track-status--${subscription.status}`}
          title={subscription.detail}
        >
          {subscriptionLabel(subscription.status)}
        </small>
      </div>
    ) : null;

  return (
    <article
      className={`participant-card participant-card--${participant.role} participant-card--${
        current ? "self" : "remote"
      } participant-card--${slug(activity)}`}
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

      {!isAi ? subscriptionControl : null}

      {isAi && onRouting ? (
        <div className="routing-controls">
          <Toggle
            label="Hears me"
            ariaLabel={`Hears me (${participant.displayName})`}
            checked={row?.hearsMe ?? false}
            onChange={(hearsMe) => onRouting(participant.id, hearsMe, row?.iHearIt ?? true)}
          />
          {subscriptionControl}
          <button
            className="ask-button"
            type="button"
            aria-pressed={isAddressing}
            onPointerDown={() => onAddressDown?.(participant.id)}
            onPointerUp={() => onAddressUp?.(participant.id)}
            onPointerLeave={() => onAddressUp?.(participant.id)}
            onBlur={() => onAddressUp?.(participant.id)}
            onKeyDown={(event) => {
              if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                event.preventDefault();
                onAddressDown?.(participant.id);
              }
            }}
            onKeyUp={(event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                onAddressUp?.(participant.id);
              }
            }}
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
  ariaLabel,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  );
}

function slug(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "-");
}

function subscriptionLabel(status: TrackSubscriptionState["status"]): string {
  switch (status) {
    case "subscribed":
      return "Subscribed";
    case "subscribing":
      return "Subscribing…";
    case "waiting":
      return "Waiting for track";
    default:
      return "Unsubscribed";
  }
}
