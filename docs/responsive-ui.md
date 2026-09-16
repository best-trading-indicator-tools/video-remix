# Responsive layout and scrolling

`src/responsive.css` loads after the component styles. Keep shared responsive
rules here so older component breakpoints cannot override the scroll boundaries.

## Layout rules

- Workspace, exports and history use document scrolling. Do not give the app
  shell a fixed height or hide its overflow to conceal a layout bug.
- Wide, tall result editors have two independently scrollable columns, each
  keyboard focusable. Header and footer growth is bounded so the columns retain
  space even with a long title or validation error.
- Inside a dialog area at most 900px wide or 650px tall, the entire editor is
  one scrollable sheet. Its header, preview, controls and footer stay in normal
  flow. Do not add another vertical scroll container inside this layout.
- `useDialogViewport` measures the visible viewport, including changes caused
  by mobile keyboards and zoom. Dialog container queries use that available
  space, rather than relying only on the layout viewport's media queries.
- Tables retain their labeled, keyboard-focusable horizontal scroll regions.
  Long native select options are clipped inside the field, including WebKit's
  option overflow; they must not widen the page or dialog.
- Short timestamps and output settings wrap according to available space.
  At small sizes, tabs and action rows wrap instead of hiding their last item.
- Opening/closing dialogs restores body overflow and focus. Closed accordion
  fields are excluded from the dialog's focus boundary.

## Browser verification

Exercise Auto, Manual, Short clips, Exports, History, export preview, result
editor and Help at:

| Width × height | Coverage |
| --- | --- |
| 320 × 568 | Small phone |
| 390 × 844 | Phone portrait |
| 390 × 320 | Reduced visible space |
| 568 × 320 | Small landscape |
| 768 × 1024 | Tablet portrait |
| 844 × 390 | Phone landscape |
| 1024 × 768 | Tablet / small desktop |
| 1440 × 900 | Desktop |

Use a browser session with API mutations mocked to avoid creating paid requests
or changing real exports. Load a completed edit with captions, B-roll and review
reports; open all accordions and both publication/results forms. Verify:

1. No document-level horizontal overflow or clipped control containers.
2. Scroll to the bottom and back up; the final action remains reachable.
3. Both desktop editor columns scroll independently. Compact editors scroll
   through the header and footer, including after resizing an open dialog.
4. Close every dialog, then scroll the page again. Test Escape and Tab/Shift+Tab.
5. All four Manual tabs, uploaded footage placements and prompt proposals fit.
6. Timestamps remain legible; comparison tables scroll sideways without moving
   the whole page; long filenames and errors wrap.
7. Simulate a visual viewport height of 280px with a nonzero offset: the dialog
   must follow that viewport and its final button must still be reachable.

Validated in Chromium and iPhone WebKit emulation. Chromium checks used real
wheel events; mobile WebKit's automation lacks wheel support, so its scroll
checks used scroll offsets and action reachability. Native phone keyboards and
touch gestures still warrant a physical-device smoke check after browser updates.
