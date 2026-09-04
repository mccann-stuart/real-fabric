import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
});
