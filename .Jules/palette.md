## 2026-10-02 - Ensure `aria-expanded` controls toggle state symmetrically
**Learning:** Controls using `aria-expanded` signal a collapsible element to screen readers, but if the click handler only opens the target element (`setOpen(true)`), keyboard/screen-reader users relying on the button cannot close it.
**Action:** Always pair `aria-expanded` attributes with toggle state handlers (`setOpen((prev) => !prev)`) and update `aria-label`/`title` strings to reflect the action that will occur on click.
