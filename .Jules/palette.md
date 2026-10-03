## 2026-10-02 - Ensure `aria-expanded` controls toggle state symmetrically
**Learning:** Controls using `aria-expanded` signal a collapsible element to screen readers, but if the click handler only opens the target element (`setOpen(true)`), keyboard/screen-reader users relying on the button cannot close it.
**Action:** Always pair `aria-expanded` attributes with toggle state handlers (`setOpen((prev) => !prev)`) and update `aria-label`/`title` strings to reflect the action that will occur on click.

## 2026-10-18 - Include SVG `<title>` elements inside SVG `<g>` groups for diagram node tooltips
**Learning:** SVG nodes that render single-letter initials or abbreviated labels leave desktop pointer users unable to identify node entities on hover, and screen readers without clear element labels.
**Action:** Always enclose SVG node shapes and texts within a `<g>` element containing a descriptive `<title>` tag with the entity's full name, role, and status.
