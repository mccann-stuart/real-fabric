import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoomTopBar } from "../src/client/components/RoomTopBar";
import { EntryPage } from "../src/client/pages/EntryPage";

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

  it("renders RoomTopBar invite button with appropriate feedback and live status region", () => {
    const htmlIdle = renderToStaticMarkup(
      React.createElement(RoomTopBar, {
        code: "TEST1234567890123456",
        copyState: "idle",
        onCopyInvite: () => {},
        micAction: { visible: true, disabled: false, label: "Start microphone" },
        liveAudioEligible: true,
        onStartAudio: () => {},
        onOpenLeaveDialog: () => {},
      }),
    );
    expect(htmlIdle).toContain("Copy invite");

    const htmlCopied = renderToStaticMarkup(
      React.createElement(RoomTopBar, {
        code: "TEST1234567890123456",
        copyState: "copied",
        onCopyInvite: () => {},
        micAction: { visible: true, disabled: false, label: "Start microphone" },
        liveAudioEligible: true,
        onStartAudio: () => {},
        onOpenLeaveDialog: () => {},
      }),
    );
    expect(htmlCopied).toContain("Invite copied");
    expect(htmlCopied).toContain("button--success");
    expect(htmlCopied).toContain("Invite link copied to the clipboard.");
  });
});
