import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ParticipantCard } from "../src/client/components/ParticipantCard";
import { EntryPage } from "../src/client/pages/EntryPage";
import type { Participant, RoutingPreference } from "../src/shared/contracts";

describe("Micro-UX & Accessibility Improvements", () => {
  it("renders EntryPage action buttons with accessible labels and attributes", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryPage, {
        navigate: () => {},
      }),
    );

    expect(html).toContain("Create demo room");
    expect(html).toContain("Join room");
    expect(html).toContain("Solo presenter mode");
    expect(html).toContain("button--primary");
    expect(html).toContain('aria-label="Mic level test"');
  });

  it("renders accessible toggle switches inside participant card", () => {
    const mockAi: Participant = {
      id: "ai-1",
      displayName: "Ada AI",
      role: "ai",
      state: "connected",
      address: "ai/ada",
      simulated: false,
      pipeline: "listening",
      joinedAt: 1000,
      reconnectUntil: null,
      wakeName: "ada",
      lastActiveAt: 1000,
    };

    const mockRouting: RoutingPreference[] = [
      {
        humanId: "human-1",
        aiId: "ai-1",
        hearsMe: true,
        iHearIt: true,
        enforcement: "cooperative",
        updatedAt: 1000,
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(ParticipantCard, {
        participant: mockAi,
        current: false,
        viewerId: "human-1",
        routing: mockRouting,
        connectedHumanIds: ["human-1"],
        onRouting: () => {},
      }),
    );

    expect(html).toContain('class="toggle-row"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-label="Hears me (Ada AI)"');
  });
});
