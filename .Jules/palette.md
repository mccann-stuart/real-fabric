## 2026-10-02 - Ensure `aria-expanded` controls toggle state symmetrically
**Learning:** Controls using `aria-expanded` signal a collapsible element to screen readers, but if the click handler only opens the target element (`setOpen(true)`), keyboard/screen-reader users relying on the button cannot close it.
**Action:** Always pair `aria-expanded` attributes with toggle state handlers (`setOpen((prev) => !prev)`) and update `aria-label`/`title` strings to reflect the action that will occur on click.

## 2026-10-18 - Include SVG `<title>` elements inside SVG `<g>` groups for diagram node tooltips
**Learning:** SVG nodes that render single-letter initials or abbreviated labels leave desktop pointer users unable to identify node entities on hover, and screen readers without clear element labels.
**Action:** Always enclose SVG node shapes and texts within a `<g>` element containing a descriptive `<title>` tag with the entity's full name, role, and status.

## 2026-10-18 - Pair unobservable metric tooltips with `role="note"` and `aria-label`
**Learning:** `span` elements using `title` attributes for tooltips on unobservable metrics ("Not exposed") do not announce the explanation reason to screen readers, and adding `aria-label` directly to generic spans triggers linting errors.
**Action:** Annotate unobservable measurement spans with `role="note"` and `aria-label={`${NOT_EXPOSED}: ${measurement.reason}`}` to expose technical reasons to assistive technology while keeping visual presentation identical.

## 2026-10-25 - Maintain WCAG 2.5.3 (Label in Name) when supplementing text buttons with `aria-label`
**Learning:** When supplementing buttons with `aria-label` to provide screen reader context, the `aria-label` must begin with or contain the exact visible inner text (e.g. `aria-label="Retry now — reconnect to room"` for `"Retry now"`). Deviating from the visible text breaks speech recognition software and voice-command navigation.
**Action:** Always ensure the visible button label appears at the start of any `aria-label`, and avoid redundant `title` attributes on text buttons to prevent UI tooltip clutter.
