## 2025-02-17 - Accessible Custom Dialogs and Repeating List Toggles
**Learning:** In repeating list items (such as `ParticipantCard`), boolean `Toggle` controls without context-specific `aria-label`s sound ambiguous to screen reader users. Additionally, `<dialog>` modals require `aria-describedby` linked to their prompt description so screen readers announce the modal purpose alongside its title.
**Action:** Always pass scoped `aria-label` props to toggles/switches rendered in repeating card layouts, and ensure dialog modals include `aria-describedby` referencing descriptive text.

## 2025-02-23 - Focus Visible Indicators for Custom Toggle Inputs
**Learning:** Custom CSS toggle switches using hidden native inputs (`opacity: 0`) lose visible keyboard focus indicators when navigated with the Tab key unless `:focus-visible` styles are explicitly targeted to the sibling visual element (e.g. `.toggle-row input:focus-visible + i`).
**Action:** Always style adjacent visual toggle spans/icons with `:focus-visible` rings when visually hiding native checkbox or radio inputs.
