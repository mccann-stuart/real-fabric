## 2025-02-17 - Accessible Custom Dialogs and Repeating List Toggles
**Learning:** In repeating list items (such as `ParticipantCard`), boolean `Toggle` controls without context-specific `aria-label`s sound ambiguous to screen reader users. Additionally, `<dialog>` modals require `aria-describedby` linked to their prompt description so screen readers announce the modal purpose alongside its title.
**Action:** Always pass scoped `aria-label` props to toggles/switches rendered in repeating card layouts, and ensure dialog modals include `aria-describedby` referencing descriptive text.

## 2025-05-20 - Resilient Hold-to-Talk Pointer and Focus States
**Learning:** Push-to-talk and hold-to-action buttons (like "Hold to ask") require `onPointerCancel` and `onBlur` handlers alongside `onPointerUp`/`onPointerLeave`. Touch gestures, scrolling, system alerts, or focus changes can cancel pointer interactions without firing `pointerup`, leaving interactive hold states stuck as active.
**Action:** Always attach `onPointerCancel` and `onBlur` to push-to-talk/hold buttons, and update button label text dynamically to reflect the active holding state.
