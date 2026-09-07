import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CapturePath } from "../src/client/audio/UniversalAudioCaptureAdapter";
import { Inspector } from "../src/client/components/Inspector";
import { LeaveRoomDialog } from "../src/client/components/LeaveRoomDialog";
import { ParticipantCard } from "../src/client/components/ParticipantCard";
import { EntryPage } from "../src/client/pages/EntryPage";
import type { Participant, RoomSnapshot, RoutingPreference } from "../src/shared/contracts";
import { notExposed } from "../src/shared/measurement";

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
  });

  it("renders ParticipantCard ask-button with accessible title and aria-label", () => {
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

    expect(html).toContain('aria-label="Hold to ask Ada AI (press and hold)"');
    expect(html).toContain('title="Press and hold (or Space/Enter) to address Ada AI"');
  });

  it("renders Inspector tabpanel with tabIndex=0 for keyboard accessibility", () => {
    const mockRoom: RoomSnapshot = {
      code: "TEST1234",
      createdAt: 1000,
      expiresAt: 100000,
      participants: [],
      routing: [],
      floor: { holderId: null, queue: [], heldSince: null },
      aiToAi: { enabled: false, turnCap: 4, consecutiveTurns: 0, cappedAt: null },
      presenter: { simulatedHumans: 0, simulatedAis: 0, scriptedResponses: false },
      composition: { humans: 1, ais: 0, valid: true },
      transport: {
        endpoint: "https://relay.test",
        endpointName: "relay.test",
        draft: "16",
        availability: "available",
        reason: "Available",
        failure: null,
        traceVerified: false,
        routingEnforcement: "cooperative",
        discovery: "subscribe_namespace",
      },
    };

    const mockMetrics = {
      transportReadyMs: notExposed<number>("Not exposed"),
      firstAudioMs: notExposed<number>("Not exposed"),
      publishedTracks: notExposed<number>("Not exposed"),
      subscribedTracks: notExposed<number>("Not exposed"),
      worstBufferMs: notExposed<number>("Not exposed"),
      outputLatencyMs: notExposed<number>("Not exposed"),
      transportRttMs: notExposed<number>("Not exposed"),
      lateDrops: notExposed<number>("Not exposed"),
      cancelledDrops: notExposed<number>("Not exposed"),
      concealedFrames: notExposed<number>("Not exposed"),
      comfortNoiseFrames: notExposed<number>("Not exposed"),
      lastBargeInMs: notExposed<number>("Not exposed"),
      lastRoutingChangeMs: notExposed<number>("Not exposed"),
      reconnects: notExposed<number>("Not exposed"),
      dtxEnabled: notExposed<boolean>("Not exposed"),
      capturePath: notExposed<CapturePath>("Not exposed"),
      publishedObjects: notExposed<number>("Not exposed"),
      subscribedObjects: notExposed<number>("Not exposed"),
      objectsPerSecond: notExposed<number>("Not exposed"),
      meanObjectBytes: notExposed<number>("Not exposed"),
      lateDropRate: notExposed<number>("Not exposed"),
      aggregateBufferMs: notExposed<number>("Not exposed"),
      worstDriftPpm: notExposed<number>("Not exposed"),
      activeDecoders: notExposed<number>("Not exposed"),
      audioInputs: notExposed<number>("Not exposed"),
      deviceChanges: notExposed<number>("Not exposed"),
    };

    const html = renderToStaticMarkup(
      React.createElement(Inspector, {
        room: mockRoom,
        viewerId: "human-1",
        phase: { name: "live" },
        metrics: mockMetrics,
        degradation: {
          step: 0,
          nominalBufferMs: 60,
          announcement: null,
          releasedDecoders: [],
          unsubscribed: [],
        },
        events: [],
        publishing: false,
        subscribedIds: [],
        negotiation: null,
        network: {
          state: "reachable",
          detail: "OK",
          remediation: null,
          elapsedMs: 10,
          reliability: "Not exposed",
          congestionControl: "Not exposed",
        },
        open: true,
        onClose: () => {},
      }),
    );

    expect(html).toContain('role="tabpanel" tabindex="0"');
  });

  it("renders LeaveRoomDialog confirm button with aria-busy when leaving", () => {
    const html = renderToStaticMarkup(
      React.createElement(LeaveRoomDialog, {
        dialogRef: { current: null },
        code: "TEST1234",
        leaveError: null,
        leaving: true,
        onCancel: () => {},
        onConfirmLeave: () => {},
      }),
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Leaving…");
  });
});
