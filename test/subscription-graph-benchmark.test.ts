import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { SubscriptionGraph } from "../src/client/components/SubscriptionGraph";
import type { Participant, RoutingPreference } from "../src/shared/contracts";

describe("SubscriptionGraph Benchmark", () => {
  it("measures render performance for SubscriptionGraph with 100 participants and routing rows", {
    timeout: 30000,
  }, () => {
    const viewerId = "human-viewer";
    const participants: Participant[] = [
      {
        id: viewerId,
        displayName: "Viewer",
        role: "human",
        state: "connected",
        joinedAt: Date.now(),
        reconnectUntil: null,
        simulated: false,
        address: null,
        wakeName: null,
        pipeline: null,
        lastActiveAt: Date.now(),
      },
    ];

    // Add 50 human participants and 50 AI participants
    for (let i = 0; i < 50; i++) {
      participants.push({
        id: `human-${i}`,
        displayName: `Human ${i}`,
        role: "human",
        state: "connected",
        joinedAt: Date.now(),
        reconnectUntil: null,
        simulated: true,
        address: null,
        wakeName: null,
        pipeline: null,
        lastActiveAt: Date.now(),
      });
    }

    const routing: RoutingPreference[] = [];
    for (let i = 0; i < 50; i++) {
      const aiId = `ai-${i}`;
      participants.push({
        id: aiId,
        displayName: `AI ${i}`,
        role: "ai",
        state: "connected",
        joinedAt: Date.now(),
        reconnectUntil: null,
        simulated: true,
        address: `ai://${aiId}`,
        wakeName: `AI${i}`,
        pipeline: "listening",
        lastActiveAt: Date.now(),
      });

      routing.push({
        humanId: viewerId,
        aiId,
        hearsMe: true,
        iHearIt: true,
        enforcement: "enforced",
        updatedAt: Date.now(),
      });
    }

    const subscribedIds = participants.map((p) => p.id);

    // Warmup
    for (let i = 0; i < 10; i++) {
      renderToStaticMarkup(
        React.createElement(SubscriptionGraph, {
          participants,
          routing,
          viewerId,
          publishing: true,
          subscribedIds,
        }),
      );
    }

    const iterations = 500;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      renderToStaticMarkup(
        React.createElement(SubscriptionGraph, {
          participants,
          routing,
          viewerId,
          publishing: true,
          subscribedIds,
        }),
      );
    }
    const end = performance.now();
    const duration = end - start;
    console.log(
      `[BENCHMARK] SubscriptionGraph render (${iterations} runs, 101 participants): ${duration.toFixed(2)} ms (avg ${(duration / iterations).toFixed(4)} ms/op)`,
    );
  });
});
