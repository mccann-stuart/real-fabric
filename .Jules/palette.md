## 2025-02-18 - Hold-to-Talk Controls and Focus Loss
**Learning:** Push-to-talk or hold-to-address buttons relying on pointer and key events can get stuck in the active state if focus is lost (e.g., via keyboard Tab navigation or window blur) before `onKeyUp` or `onPointerUp` fires.
**Action:** Always include an `onBlur` handler on interactive press-and-hold elements to safely release active state on focus loss.

## 2025-02-17 - Accessible Custom Dialogs and Repeating List Toggles
**Learning:** In repeating list items (such as `ParticipantCard`), boolean `Toggle` controls without context-specific `aria-label`s sound ambiguous to screen reader users. Additionally, `<dialog>` modals require `aria-describedby` linked to their prompt description so screen readers announce the modal purpose alongside its title.
**Action:** Always pass scoped `aria-label` props to toggles/switches rendered in repeating card layouts, and ensure dialog modals include `aria-describedby` referencing descriptive text.
