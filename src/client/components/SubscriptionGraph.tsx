import type { Participant, RoutingPreference } from "../../shared/contracts";

/**
 * §4.3: the live publisher and subscriber graph, "the centrepiece at scale".
 *
 * Edges are computed from real state — this participant's publication, this
 * participant's subscriptions, and the inbound routing rows. Turning off
 * "Hears me" makes an edge disappear here because the subscription stopped
 * existing, which is the whole argument of §2 point four.
 */

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "publication" | "subscription" | "ai_inbound";
  live: boolean;
}

export function buildEdges(
  participants: readonly Participant[],
  routing: readonly RoutingPreference[],
  viewerId: string,
  publishing: boolean,
  subscribedIds: readonly string[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  if (publishing) {
    edges.push({
      id: `pub:${viewerId}`,
      from: viewerId,
      to: "relay",
      kind: "publication",
      live: true,
    });
  }
  for (const participant of participants) {
    if (participant.id === viewerId || participant.state === "left") continue;
    edges.push({
      id: `sub:${participant.id}`,
      from: "relay",
      to: viewerId,
      kind: "subscription",
      live: subscribedIds.includes(participant.id),
    });
  }
  // Inbound routing: which humans each AI is subscribed to. Only the viewer's
  // own rows are theirs to see, so only those are drawn as owned edges.
  for (const row of routing) {
    if (row.humanId !== viewerId) continue;
    edges.push({
      id: `ai:${row.aiId}:${row.humanId}`,
      from: row.humanId,
      to: row.aiId,
      kind: "ai_inbound",
      live: row.hearsMe,
    });
  }
  return edges;
}

export function SubscriptionGraph({
  participants,
  routing,
  viewerId,
  publishing,
  subscribedIds,
}: {
  participants: readonly Participant[];
  routing: readonly RoutingPreference[];
  viewerId: string;
  publishing: boolean;
  subscribedIds: readonly string[];
}) {
  const active = participants.filter((participant) => participant.state !== "left");
  const edges = buildEdges(participants, routing, viewerId, publishing, subscribedIds);
  const size = 260;
  const centre = size / 2;
  const radius = size / 2 - 30;

  const positions = new Map<string, { x: number; y: number }>();
  positions.set("relay", { x: centre, y: centre });
  active.forEach((participant, index) => {
    const angle = (index / Math.max(1, active.length)) * Math.PI * 2 - Math.PI / 2;
    positions.set(participant.id, {
      x: centre + Math.cos(angle) * radius,
      y: centre + Math.sin(angle) * radius,
    });
  });

  return (
    <div className="graph-view">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Live subscription graph">
        {edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          return (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              className={`graph-edge graph-edge--${edge.kind}${edge.live ? "" : " graph-edge--dormant"}`}
            />
          );
        })}
        <rect
          x={centre - 26}
          y={centre - 13}
          width={52}
          height={26}
          className="graph-relay"
          rx={1}
        />
        <text x={centre} y={centre + 4} className="graph-relay-label" textAnchor="middle">
          relay
        </text>
        {active.map((participant) => {
          const point = positions.get(participant.id);
          if (!point) return null;
          return (
            <g key={participant.id}>
              <circle
                cx={point.x}
                cy={point.y}
                r={11}
                className={`graph-node graph-node--${participant.role}${
                  participant.simulated ? " graph-node--simulated" : ""
                }`}
              />
              <text x={point.x} y={point.y + 4} className="graph-node-label" textAnchor="middle">
                {participant.displayName.at(0)?.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className="graph-key">
        <li className="graph-key--publication">Publication — one track out</li>
        <li className="graph-key--subscription">Subscription — n−1 tracks in</li>
        <li className="graph-key--ai">AI inbound — dashed when consent is off</li>
      </ul>
    </div>
  );
}
