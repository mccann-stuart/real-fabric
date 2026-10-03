import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CapturePath } from "../src/client/audio/UniversalAudioCaptureAdapter";
import { DemoScriptPanel } from "../src/client/components/DemoScriptPanel";
import { Inspector } from "../src/client/components/Inspector";
import { LeaveRoomDialog } from "../src/client/components/LeaveRoomDialog";
import { ParticipantCard } from "../src/client/components/ParticipantCard";
import { PreflightPanel } from "../src/client/components/PreflightPanel";
import { RoomStatusStack } from "../src/client/components/RoomStatusStack";
import { RoomTopBar } from "../src/client/components/RoomTopBar";
import { SubscriptionGraph } from "../src/client/components/SubscriptionGraph";
import { EntryPage } from "../src/client/pages/EntryPage";
import { PreflightPage } from "../src/client/pages/PreflightPage";
import type { Participant, RoomSnapshot, RoutingPreference } from "../src/shared/contracts";
import { notExposed } from "../src/shared/measurement";
import { matchConfiguration } from "../src/shared/pinnedConfiguration";

const TEST_CONFIGURATION = matchConfiguration({
  userAgent: "Mozilla/5.0 (Macintosh) Chrome/141.0.0.0 Safari/537.36",
  brands: [{ brand: "Google Chrome", version: "141" }],
  platform: "macOS",
});

describe("Micro-UX & Accessibility Improvements", () => {
  it("renders EntryPage action buttons with accessible labels and attributes", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryPage, {
        configuration: TEST_CONFIGURATION,
        navigate: () => {},
      }),
    );

    expect(html).toContain("Create demo room");
    expect(html).toContain("Join room");
    expect(html).toContain("Solo presenter mode");
    expect(html).toContain("button--primary");
    expect(html).toContain('aria-label="Mic level test"');
    expect(html).toContain("Microphone level not exposed until the test runs.");
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
        partialContext: false,
        onRouting: () => {},
      }),
    );

    expect(html).toContain('class="toggle-row"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-label="Hears me (Ada AI)"');
    expect(html).toContain('aria-label="Hold to ask Ada AI (press and hold)"');
    expect(html).toContain('aria-describedby="ask-desc-ai-1"');
    expect(html).toContain('title="Press and hold (or Space/Enter) to address Ada AI"');
  });

  it("shows a measured microphone level only while capture is available", () => {
    const human: Participant = {
      id: "human-1",
      displayName: "Ada",
      role: "human",
      state: "connected",
      address: null,
      simulated: false,
      pipeline: null,
      joinedAt: 1_000,
      reconnectUntil: null,
      wakeName: null,
      lastActiveAt: 1_000,
    };
    const props = {
      participant: human,
      current: true,
      viewerId: human.id,
      routing: [],
      partialContext: false,
    };
    const idle = renderToStaticMarkup(React.createElement(ParticipantCard, props));
    expect(idle).toContain("Not exposed");
    expect(idle).not.toContain("<meter");

    const capturing = renderToStaticMarkup(
      React.createElement(ParticipantCard, { ...props, levelAvailable: true, level: 0.4 }),
    );
    expect(capturing).toContain("<meter");
    expect(capturing).toContain('value="40"');
  });

  it("renders invite feedback states and accessible labels on RoomTopBar copy button", () => {
    const baseProps = {
      code: "TEST1234567890123456",
      onCopyInvite: () => {},
      micAction: { visible: true, disabled: false, label: "Start microphone" },
      liveAudioEligible: true,
      onStartAudio: () => {},
      onOpenLeaveDialog: () => {},
    };

    const idle = renderToStaticMarkup(
      React.createElement(RoomTopBar, { ...baseProps, copyState: "idle" }),
    );
    expect(idle).toContain("Copy invite");
    expect(idle).toContain('aria-label="Copy invite link to clipboard"');
    expect(idle).toContain('title="Copy invite link to clipboard"');

    const copied = renderToStaticMarkup(
      React.createElement(RoomTopBar, { ...baseProps, copyState: "copied" }),
    );
    expect(copied).toContain("Invite copied");
    expect(copied).toContain("button--success");
    expect(copied).toContain('aria-label="Invite link copied to clipboard"');
    expect(copied).toContain('title="Invite link copied to clipboard"');
    expect(copied).toContain("Invite link copied to the clipboard.");

    const failed = renderToStaticMarkup(
      React.createElement(RoomTopBar, { ...baseProps, copyState: "failed" }),
    );
    expect(failed).toContain("Retry copy");
    expect(failed).toContain('aria-label="Retry copying invite link"');
    expect(failed).toContain('title="Retry copying invite link"');
  });

  it("makes the active inspector panel keyboard reachable", () => {
    const room: RoomSnapshot = {
      code: "TEST1234",
      createdAt: 1_000,
      expiresAt: 100_000,
      participants: [],
      routing: [],
      partialContextAiIds: [],
      floor: { holderId: null, queue: [], heldSince: null },
      aiToAi: { enabled: false, turnCap: 6, consecutiveTurns: 0, cappedAt: null },
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
    const metrics = {
      transportReadyMs: notExposed<number>("Not exposed"),
      firstAudioMs: notExposed<number>("Not exposed"),
      publishedTracks: notExposed<number>("Not exposed"),
      subscribedTracks: notExposed<number>("Not exposed"),
      worstBufferMs: notExposed<number>("Not exposed"),
      jitterTargetMs: notExposed<number>("Not exposed"),
      captureFrameMs: notExposed<number>("Not exposed"),
      encodeCallbackMs: notExposed<number>("Not exposed"),
      receiverHoldMs: notExposed<number>("Not exposed"),
      decodeCallbackMs: notExposed<number>("Not exposed"),
      outputLatencyMs: notExposed<number>("Not exposed"),
      transportRttMs: notExposed<number>("Not exposed"),
      transportMinRttMs: notExposed<number>("Not exposed"),
      transportRttVariationMs: notExposed<number>("Not exposed"),
      publishSetupMs: notExposed<number>("Not exposed"),
      subscribeSetupMs: notExposed<number>("Not exposed"),
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
      publishedObjectsPerSecond: notExposed<number>("Not exposed"),
      objectsPerSecond: notExposed<number>("Not exposed"),
      meanPublishedObjectBytes: notExposed<number>("Not exposed"),
      meanObjectBytes: notExposed<number>("Not exposed"),
      lastPublishedObjectId: notExposed<number>("Not exposed"),
      lastSubscribedObjectId: notExposed<number>("Not exposed"),
      lastPublishedObjectAgeMs: notExposed<number>("Not exposed"),
      lastSubscribedObjectAgeMs: notExposed<number>("Not exposed"),
      lateDropRate: notExposed<number>("Not exposed"),
      aggregateBufferMs: notExposed<number>("Not exposed"),
      worstDriftPpm: notExposed<number>("Not exposed"),
      activeDecoders: notExposed<number>("Not exposed"),
      audioInputs: notExposed<number>("Not exposed"),
      deviceChanges: notExposed<number>("Not exposed"),
    };
    const html = renderToStaticMarkup(
      React.createElement(Inspector, {
        room,
        viewerId: "human-1",
        phase: { name: "live" },
        metrics,
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
    expect(html).toContain('aria-keyshortcuts="1"');
    expect(html).toContain('aria-label="Signal path (Shortcut: 1)"');
    expect(html).toContain('title="Signal path (Shortcut: 1)"');
    expect(html).toContain('aria-keyshortcuts="5"');
    expect(html).toContain('<span aria-hidden="true">×</span>');
  });

  it("announces the pending leave action and sets aria-modal", () => {
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

    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Leaving…");
  });

  it("renders RoomTopBar live audio button with aria-busy when starting/disabled", () => {
    const html = renderToStaticMarkup(
      React.createElement(RoomTopBar, {
        code: "TEST1234567890123456",
        copyState: "idle",
        onCopyInvite: () => {},
        micAction: { visible: true, disabled: true, label: "Starting audio…" },
        liveAudioEligible: true,
        onStartAudio: () => {},
        onOpenLeaveDialog: () => {},
      }),
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Starting audio… (please wait)"');
    expect(html).toContain('title="Starting audio… (please wait)"');
    expect(html).toContain("Starting audio…");
  });

  it("renders styled retry button in RoomStatusStack terminal phase", () => {
    const html = renderToStaticMarkup(
      React.createElement(RoomStatusStack, {
        configuration: TEST_CONFIGURATION,
        state: {
          phase: { name: "terminal", failure: "udp_blocked" },
          room: null,
          degradation: {
            step: 0,
            nominalBufferMs: 60,
            announcement: null,
            releasedDecoders: [],
            unsubscribed: [],
          },
          failures: [],
          capture: { name: "idle" },
          muted: false,
          speaking: false,
          micLevel: 0,
          publishing: false,
          audioLifecycle: {
            audioSession: "not_exposed",
            wakeLock: "not_exposed",
            wakeLockReason: "Not exposed",
          },
          subscriptions: [],
          subscribedParticipantIds: [],
          negotiation: null,
          network: {
            state: "not_run",
            detail: "",
            remediation: null,
            elapsedMs: 0,
            reliability: "Not exposed",
            congestionControl: "Not exposed",
          },
          events: [],
          metrics: {
            transportReadyMs: notExposed<number>("Not exposed"),
            firstAudioMs: notExposed<number>("Not exposed"),
            publishedTracks: notExposed<number>("Not exposed"),
            subscribedTracks: notExposed<number>("Not exposed"),
            worstBufferMs: notExposed<number>("Not exposed"),
            jitterTargetMs: notExposed<number>("Not exposed"),
            captureFrameMs: notExposed<number>("Not exposed"),
            encodeCallbackMs: notExposed<number>("Not exposed"),
            receiverHoldMs: notExposed<number>("Not exposed"),
            decodeCallbackMs: notExposed<number>("Not exposed"),
            outputLatencyMs: notExposed<number>("Not exposed"),
            transportRttMs: notExposed<number>("Not exposed"),
            transportMinRttMs: notExposed<number>("Not exposed"),
            transportRttVariationMs: notExposed<number>("Not exposed"),
            publishSetupMs: notExposed<number>("Not exposed"),
            subscribeSetupMs: notExposed<number>("Not exposed"),
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
            publishedObjectsPerSecond: notExposed<number>("Not exposed"),
            objectsPerSecond: notExposed<number>("Not exposed"),
            meanPublishedObjectBytes: notExposed<number>("Not exposed"),
            meanObjectBytes: notExposed<number>("Not exposed"),
            lastPublishedObjectId: notExposed<number>("Not exposed"),
            lastSubscribedObjectId: notExposed<number>("Not exposed"),
            lastPublishedObjectAgeMs: notExposed<number>("Not exposed"),
            lastSubscribedObjectAgeMs: notExposed<number>("Not exposed"),
            lateDropRate: notExposed<number>("Not exposed"),
            aggregateBufferMs: notExposed<number>("Not exposed"),
            worstDriftPpm: notExposed<number>("Not exposed"),
            activeDecoders: notExposed<number>("Not exposed"),
            audioInputs: notExposed<number>("Not exposed"),
            deviceChanges: notExposed<number>("Not exposed"),
          },
        },
        reclaimed: false,
        error: null,
        iphoneAudioCandidate: false,
        hiddenFailureCodes: [],
        onRetry: () => {},
        onDismissFailure: () => {},
      }),
    );

    expect(html).toContain('class="button button--compact"');
    expect(html).toContain("Retry now");
  });

  it("renders PreflightPage test microphone button with default text", () => {
    const html = renderToStaticMarkup(
      React.createElement(PreflightPage, {
        configuration: TEST_CONFIGURATION,
        navigate: () => {},
      }),
    );

    expect(html).toContain("Test microphone permission");
  });

  it("renders DemoScriptPanel action buttons with descriptive aria labels when running", () => {
    const html = renderToStaticMarkup(
      React.createElement(DemoScriptPanel, {
        currentStep: {
          id: "step-1",
          atSeconds: 0,
          action: "Start speech",
          mustBeVisible: "Waveform visible",
          verification: "presenter",
        },
        runs: [],
        cleanRuns: 0,
        releaseGateMet: false,
        running: true,
        onBegin: () => {},
        onRecord: () => {},
        onAbandon: () => {},
      }),
    );

    expect(html).toContain('aria-label="Mark cue at 0:00 as seen"');
    expect(html).toContain('aria-label="Mark cue at 0:00 as not seen"');
    expect(html).toContain('aria-label="Skip cue at 0:00"');
    expect(html).toContain('aria-label="Abandon current demo run"');
  });

  it("renders PreflightPanel with fieldset legend groupings for required and optional checks", () => {
    const html = renderToStaticMarkup(
      React.createElement(PreflightPanel, {
        report: {
          secureContext: "ready",
          webTransport: "ready",
          webTransportReliability: "ready",
          opusEncoder: "ready",
          opusDecoder: "ready",
          capture: "ready",
          captureReason: "",
          playout: "ready",
          playoutReason: "",
          microphone: "ready",
          audioSession: "ready",
          wakeLock: "ready",
          dtx: "ready",
          lowLatencyCongestionControl: "ready",
          codecReason: "",
          relay: "ready",
          relayReason: "",
          network: {
            state: "reachable",
            detail: "",
            remediation: null,
            elapsedMs: 0,
            reliability: "Not exposed",
            congestionControl: "Not exposed",
          },
          failure: null,
        },
      }),
    );

    expect(html).toContain("Required capabilities");
    expect(html).toContain("Optional enhancements");
  });

  it("shows actual subscription and consent states without treating missing routing as off", () => {
    const participant = (id: string, role: "human" | "ai"): Participant => ({
      id,
      displayName: id,
      role,
      state: "connected",
      address: role === "ai" ? `ai/${id}` : null,
      wakeName: role === "ai" ? id : null,
      pipeline: role === "ai" ? "listening" : null,
      simulated: false,
      joinedAt: 1_000,
      reconnectUntil: null,
      lastActiveAt: 1_000,
    });
    const html = renderToStaticMarkup(
      React.createElement(SubscriptionGraph, {
        participants: [
          participant("you", "human"),
          participant("atlas", "ai"),
          participant("sage", "ai"),
        ],
        routing: [
          {
            humanId: "you",
            aiId: "atlas",
            hearsMe: true,
            iHearIt: true,
            enforcement: "cooperative",
            updatedAt: 1_000,
          },
        ],
        viewerId: "you",
        publishing: false,
        subscribedIds: ["atlas"],
      }),
    );

    expect(html).toContain("Subscription graph connection details");
    expect(html).toContain("Not publishing");
    expect(html).toContain("Subscribed");
    expect(html).toContain("Not subscribed");
    expect(html).toContain("On (cooperative)");
    expect(html).toContain("Not exposed");
  });

  it("renders SVG title elements for relay and participant graph nodes", () => {
    const participant = (
      id: string,
      name: string,
      role: "human" | "ai",
      simulated = false,
    ): Participant => ({
      id,
      displayName: name,
      role,
      state: "connected",
      address: role === "ai" ? `ai/${id}` : null,
      wakeName: role === "ai" ? id : null,
      pipeline: role === "ai" ? "listening" : null,
      simulated,
      joinedAt: 1_000,
      reconnectUntil: null,
      lastActiveAt: 1_000,
    });
    const html = renderToStaticMarkup(
      React.createElement(SubscriptionGraph, {
        participants: [
          participant("you", "Ada Lovelace", "human"),
          participant("atlas", "Atlas AI", "ai", true),
        ],
        routing: [],
        viewerId: "you",
        publishing: false,
        subscribedIds: [],
      }),
    );

    expect(html).toContain("<title>MoQ Relay</title>");
    expect(html).toContain("<title>Ada Lovelace (Human, You)</title>");
    expect(html).toContain("<title>Atlas AI (AI, Simulated)</title>");
  });
});
