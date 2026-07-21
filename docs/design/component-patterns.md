# Component Patterns

This document explains recurring component anatomy and interaction. Visual
tokens, radii, colors, shadows, and typography remain authoritative in
[`../../DESIGN.md`](../../DESIGN.md).

## SectionGrid

`SectionGrid` and `SectionGridItem` are the default primitives for a bordered
collection of related rows or cells.

- The container owns one real 1px outer hairline, an 8px radius, and a 1px grid
  gap using the soft hairline token.
- The container leaves overflow visible so focus treatment and intentional
  overlays are not truncated. Every item constrains its own content and must
  respect the grid's outer corner geometry.
- Every child owns a white surface. Gaps become internal separators.
- Items may span rows or columns, supporting vertical lists, horizontal lists,
  and mixed metric grids without a new card implementation.
- Never simulate the outer border with padding and a background; child surfaces
  flatten or clip the visible corners.
- Avoid adding independent borders to items inside the grid. Double borders are
  the usual cause of unexpectedly thick separators.

Use `SectionGrid` for Session metrics, policy groups, service monitors, and the
two-row routing control. Do not use it merely to put a border around unrelated
page sections.

## Section headings

Section headings are open, not card headers. Keep the title, short descriptor,
and optional action on one baseline. Actions such as “Open live traffic” and
“View all” belong at the end of the same heading row and share the same compact
text-button treatment.

## Choice controls

Routing mode uses shadcn `ToggleGroup` backed by Base UI:

- the group owns a single visual outline;
- adjacent items share 1px boundaries;
- `aria-pressed` communicates selection;
- selection is exclusive.

System Proxy and TUN use two standalone shadcn `Toggle` controls because they
are independent capabilities. Each control owns a complete outline and radius,
and `aria-pressed` communicates its state. Use the same muted pressed surface as
Routing mode; preserve the green icon as the additional enabled-state cue.

Use shadcn `ButtonGroup` only when unlike actions intentionally form one joined
control. The capture help trigger is a separate outline button beside the two
capture toggles because it explains the modes rather than selecting one.
Do not rebuild pressed-state or roving-focus behavior with manually coordinated
buttons.

## Settings items

Every Settings preference uses the shared `SettingsRow` anatomy: one copy slot
for its title and description, followed by one control slot for the value,
status, selector, or action. The row owns responsive placement; individual
controls must not choose their own row alignment.

At comfortable widths, the copy starts at the leading edge and the control slot
ends at the trailing edge. When the row reflows, the control slot moves below
the copy and every control aligns to the leading edge. This keeps the control
attached to its explanation and gives mixed-width buttons, badges, and selectors
one stable scan line. Compound controls may wrap internally, but must preserve
that shared leading edge. Use a container query for this component-level reflow
instead of inferring available row space from the full window width.

## Dialogs, menus, and forms

Use shadcn Base UI `DropdownMenu` for compact action and profile menus. Compose
selection dialogs from `Dialog` and `Command`; use `Field`, `Input`, and
`AlertDialog` for editable service data and destructive confirmation. Validation
must be visible in text, reflected with `aria-invalid`, and prevent an invalid
save. Because Base UI input change callbacks expose the value directly, bind
controlled inputs with `onValueChange(value)` instead of assuming a native DOM
change event.

Do not place a bordered, rounded collection flush against a dialog boundary.
Nested borders and coincident radii create doubled hairlines and expose the
child corners against the dialog outline. Either inset the complete child by at
least the medium spacing token so both outlines remain visually distinct, or
remove the child's outer border and radius and use separators between its rows.
Full-width dialog lists should use the borderless treatment.

Pressed fills stay close to white. Selection should be clear through border,
icon, and text changes without becoming a dark gray trough.

## Notifications and recoverable failures

Use the existing Sonner toast and notification center for recoverable command
failures, failed confirmations, and capture-state warnings. Do not insert these
messages into page flow, because a transient failure must not move the control
the user just operated. Keep load failures that prevent a page from presenting
authoritative content in the page itself.

Recovery actions belong in both the toast and notification-center item when the
runtime exposes them. System Proxy drift must preserve the typed `repair` and
`leave-as-is` choices instead of reducing recovery to a generic retry. Pending
state remains available to assistive technology through a polite live region.

## ProxyControlButton

The sidebar aggregate action is documented behaviorally in
[`../product/status-experience.md`](../product/status-experience.md). Its layout
must use the same icon and label columns as navigation. Default and hover content
are stacked in the same geometry and crossfade with opacity; do not translate
the SVG or label during the transition because fractional compositing can leave
one-pixel artifacts on Retina displays.

The animated material is clipped behind a DOM fallback. It pauses when hidden,
uses a static frame under reduced motion, cleans up WebGL resources, and caps
draws at a simple 30, 45, or 60 FPS capability tier.

## User-authored labels

Group, node, profile, and service names are arbitrary Unicode strings. Render
the complete label verbatim and do not parse an emoji prefix. Apply the current
40% saturation treatment to the complete user-authored label layer. This is a
visual compromise, not semantic normalization: dark emoji can remain darker
than colorful emoji, and the product must not rewrite the user's label to fix
that difference.

Truncate only where the layout requires it, preserve the full accessible name,
and expose the complete label through an appropriate detail or tooltip when it
is not otherwise available.

## Icons

- Use Phosphor for general interface icons.
- Render service brands from their configured HTTPS image URLs without framed
  icon tiles. Defaults use version-pinned Remix Icon assets through npmmirror;
  use a neutral cloud symbol for Cloudflare and do not replace a
  user-configured URL with a bundled component.
- Do not substitute a browser logo for a service brand.
- Keep ordinary navigation and metadata icons neutral; reserve color for
  traffic direction, service identity, and state.
- Icon meaning must be reinforced by text or an accessible label.

## Sparklines

Traffic sparklines are decorative area lines with no background, axes, grid,
markers, application role, or focus outline. Use a low-opacity fill down to the
baseline and fade all four edges into the row. Hide the chart before it compresses
labels or rates. The adjacent text value is always authoritative.

## Responsive composition

Prefer container queries for component-level crowding and page media queries
for the main column change. Preserve reading order when Session and Groups
stack. Do not shrink text below the design scale merely to keep a desktop row
intact.

## Desktop interaction

- Sidebar destinations support Arrow Up, Arrow Down, Home, End, and
  first-character focus movement. Enter remains the explicit activation step,
  so focus exploration does not unexpectedly replace the active page.
- Command-F focuses and selects the current page search field. Escape clears a
  non-empty search first, then leaves the empty field when pressed again.
- The toolbar profile menu uses transactional Profile activation in the desktop
  runtime. The browser fixture uses only its isolated in-memory Status selection
  seam so the dropdown can be demonstrated without implying Core activation.
- Each destination remembers its page-scroller position while the application
  shell remains mounted.
- Initial load and browser refresh update the document title without moving
  focus. In-app route changes move assistive-technology focus to the new heading,
  but headings never draw an interactive-control focus ring.
- Deferred local route chunks remain visually quiet for the first 200 ms. If a
  transition exceeds that threshold, show the compact spinner rather than a
  skeleton placeholder.
- Desktop controls keep the default cursor and expose an immediate pressed state.
  Browser clients retain ordinary link and button cursors, while both desktop
  and browser chrome prevent accidental text selection. Editable controls, code,
  and explicitly marked content remain selectable. Links and images do not
  expose browser-style drag previews unless a real drag source opts in with
  `data-native-draggable="true"`.
