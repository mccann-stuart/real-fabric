const STEPS = [
  ["Microphone", "Live audio"],
  ["Opus", "48 kHz · 32 kbit/s"],
  ["MoQ track", "Independent objects"],
  ["WebTransport", "Bidirectional session"],
  ["HTTP/3", "Over QUIC"],
  ["Relay", "Draft 20 unavailable"],
] as const;

export function SignalPath() {
  return (
    <section className="signal-path" aria-labelledby="signal-path-title">
      <h2 id="signal-path-title">Live signal path</h2>
      <ol>
        {STEPS.map(([title, detail], index) => (
          <li
            key={title}
            className={
              index < 3 ? "signal-path__step signal-path__step--media" : "signal-path__step"
            }
          >
            <span className="signal-path__node" aria-hidden="true" />
            <span>
              <strong>{title}</strong>
              <small>{detail}</small>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
