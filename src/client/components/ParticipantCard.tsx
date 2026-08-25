export interface DisplayParticipant {
  id: string;
  displayName: string;
  role: "human" | "ai";
  state: "connected" | "reconnecting" | "left";
  activity: "Listening" | "Speaking" | "Thinking" | "Partial context" | "Unavailable";
  simulated: boolean;
}

export interface LocalRouting {
  hearsMe: boolean;
  iHearIt: boolean;
}

const WAVE_BARS = Array.from({ length: 34 }, (_, value) => ({ id: `wave-${value}`, value }));

export function ParticipantCard({
  participant,
  current,
  routing,
  onRouting,
  onAsk,
}: {
  participant: DisplayParticipant;
  current: boolean;
  routing?: LocalRouting;
  onRouting?: (routing: LocalRouting) => void;
  onAsk?: () => void;
}) {
  const isAi = participant.role === "ai";
  return (
    <article
      className={`participant-card participant-card--${participant.role} participant-card--${participant.activity.toLowerCase().replace(" ", "-")}`}
    >
      <span className="participant-card__avatar" aria-hidden="true">
        {participant.displayName.at(0)?.toUpperCase()}
      </span>
      <div className="participant-card__identity">
        <h3>{participant.displayName}</h3>
        <p className="participant-card__labels">
          {current ? <span>You</span> : null}
          <span>{participant.role === "ai" ? "AI" : "Human"}</span>
          {participant.simulated ? <span>Simulated</span> : null}
        </p>
        <p className={`participant-card__state participant-card__state--${participant.state}`}>
          <i aria-hidden="true" />{" "}
          {participant.state === "reconnecting" ? "Reconnecting" : participant.activity}
        </p>
      </div>
      <div className="waveform" aria-hidden="true">
        {participant.simulated ? (
          WAVE_BARS.map((bar) => (
            <i
              key={bar.id}
              style={{
                height: `${4 + ((bar.value * 11 + participant.displayName.length * 3) % 28)}px`,
              }}
            />
          ))
        ) : (
          <span>Not exposed</span>
        )}
      </div>
      {isAi && routing ? (
        <div className="routing-controls">
          <Toggle
            label="Hears me"
            checked={routing.hearsMe}
            onChange={(hearsMe) => onRouting?.({ ...routing, hearsMe })}
          />
          <Toggle
            label="I hear it"
            checked={routing.iHearIt}
            onChange={(iHearIt) => onRouting?.({ ...routing, iHearIt })}
          />
          <button className="ask-button" type="button" onPointerDown={onAsk} onPointerUp={onAsk}>
            Hold to ask {participant.displayName}
          </button>
          <small>Cooperative routing · presenter simulation</small>
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
