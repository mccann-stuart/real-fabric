## 2026-02-17 - Accessible Custom Dialogs and Repeating List Toggles
**Learning:** In repeating list items (such as `ParticipantCard`), boolean `Toggle` controls without context-specific `aria-label`s sound ambiguous to screen reader users. Additionally, `<dialog>` modals require `aria-describedby` linked to their prompt description so screen readers announce the modal purpose alongside its title.
**Action:** Always pass scoped `aria-label` props to toggles/switches rendered in repeating card layouts, and ensure dialog modals include `aria-describedby` referencing descriptive text.

## 2026-02-23 - Focus Visible Indicators for Custom Toggle Inputs
**Learning:** Custom CSS toggle switches using hidden native inputs (`opacity: 0`) lose visible keyboard focus indicators when navigated with the Tab key unless `:focus-visible` styles are explicitly targeted to the sibling visual element (e.g. `.toggle-row input:focus-visible + i`).
**Action:** Always style adjacent visual toggle spans/icons with `:focus-visible` rings when visually hiding native checkbox or radio inputs.

## 2026-09-09 - Contextual ARIA Labels on DemoScript and Preflight Panels
**Learning:** Interactive controls in presenter panels (such as `DemoScriptPanel` pass/fail/abandon cues) and preflight diagnostic steps need clear, context-specific `aria-label` attributes to distinguish similar actions across sequential cues.
**Action:** Provide explicit, descriptive `aria-label` strings for every action button in multi-step demonstration panels.

## 2026-09-09 - Audio Calibration Accessibility
**Learning:** Audio level visual meters and microphone test controls must convey dynamic level changes and active/inactive state to assistive technology without flooding screen reader speech queues.
**Action:** Use `role="meter"` with bounded `aria-valuenow` / `aria-valuetext` and explicit `aria-pressed` states on microphone calibration buttons.

## Next steps and vision statements

Forward-looking user experience and accessibility roadmap targets:

1. **Inspector keyboard shortcuts (Next step):** Implement keyboard navigation for rapid tab switching between Overview, Objects, Latency and Events tabs in the protocol inspector.
2. **Accessible SVG subscription graph (Vision target):** Provide an accessible hierarchical table or tree view alternative for the live publisher/subscriber canvas graph.
3. **Real-time captions and transcript display (Vision statement):** Design a WCAG 2.2 AA compliant live captioning container that scales cleanly without obscuring participant cards or inspector telemetry.
