import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ParticipantCard } from "../src/client/components/ParticipantCard";
import type { Participant, RoutingPreference } from "../src/shared/contracts";

describe("ParticipantCard component", () => {
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

  it("renders AI participant card correctly with accessible toggle labels", () => {
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

    expect(html).toContain("Ada AI");
    expect(html).toContain("Hold to ask Ada AI");
    expect(html).toContain('aria-label="Hears me (Ada AI)"');
  });

  it("invokes onAddressDown and onAddressUp on keyboard Space/Enter events", () => {
    const onAddressDown = vi.fn();
    const onAddressUp = vi.fn();

    const element = ParticipantCard({
      participant: mockAi,
      current: false,
      viewerId: "human-1",
      routing: mockRouting,
      connectedHumanIds: ["human-1"],
      onRouting: () => {},
      onAddressDown,
      onAddressUp,
    });

    // Find ask-button in element tree
    const routingDiv = element.props.children[4];
    const askButton = routingDiv.props.children[2];

    expect(askButton.props.className).toBe("ask-button");

    const preventDefault = vi.fn();

    // KeyDown Space (first press)
    askButton.props.onKeyDown({ key: " ", repeat: false, preventDefault });
    expect(onAddressDown).toHaveBeenCalledWith("ai-1");
    expect(preventDefault).toHaveBeenCalled();

    // KeyDown Space (held repeat)
    onAddressDown.mockClear();
    askButton.props.onKeyDown({ key: " ", repeat: true, preventDefault });
    expect(onAddressDown).not.toHaveBeenCalled();

    // KeyUp Space
    askButton.props.onKeyUp({ key: " ", preventDefault });
    expect(onAddressUp).toHaveBeenCalledWith("ai-1");

    // KeyDown Enter
    onAddressDown.mockClear();
    askButton.props.onKeyDown({ key: "Enter", repeat: false, preventDefault });
    expect(onAddressDown).toHaveBeenCalledWith("ai-1");

    // KeyUp Enter
    askButton.props.onKeyUp({ key: "Enter", preventDefault });
    expect(onAddressUp).toHaveBeenCalledWith("ai-1");

    // Blur event
    onAddressUp.mockClear();
    askButton.props.onBlur();
    expect(onAddressUp).toHaveBeenCalledWith("ai-1");
  });
});
