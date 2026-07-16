# Design QA

## Current comparison target

- Selected system: [Cal.com DESIGN.md](https://getdesign.md/cal/design-md)
- Product-shell references: supplied Codex and Arc screenshots
- Current implementation capture:
  `/Users/asuka/repositories/mihomo-web-client/sketch/cal-base-ui-workbench.png`
- Grouped-list refinement capture:
  `/Users/asuka/repositories/mihomo-web-client/sketch/grouped-routes-active-border.png`
- Verification viewport: 1180 × 820
- State: Status, connected, Rule mode, HKG-02

## Visual review

The implementation applies Cal.com's neutral ink, gray surface ladder, 4px
spacing rhythm, 8px controls, 12px containers, hairlines, and sparse elevation.
It deliberately excludes Cal's marketing layouts, display typography, large
section spacing, and card grids.

The window keeps the approved two-layer composition. The muted base contains a
164px task sidebar; the foreground white workspace is inset 10px from the top,
right, and bottom. The workspace contains both toolbar and active page. The
Status page has one tonal status surface followed by two flat information
sections. It has no persistent inspector, nested page card, dashboard grid, or
wide configuration stack.

At 1180 × 820, browser-computed geometry confirms:

- 164px sidebar width
- 10px top, right, and bottom workspace insets
- 12px workspace and status-surface radii
- 940px status-surface width
- no body-level horizontal or vertical overflow

## Component and interaction review

The sketch now uses `@base-ui/react` for the stateful interaction layer:

- Tabs: task navigation and workspace panels
- Switch: connection state
- ToggleGroup and Toggle: routing mode and quick-route selection
- Popover: diagnostics disclosure
- Tooltip: icon-only expert controls

Browser verification confirmed routing-mode selection, connection toggling,
diagnostics open and close, workspace tab navigation, and restoration of the
default state. The accessibility tree exposes selected tabs, pressed toggles,
the checked switch, and the diagnostics dialog. The browser console contains no
warnings or errors.

## Runtime verification

- `npm run build`: passed
- `npx @google/design.md lint ../DESIGN.md`: passed with no errors
- `git diff --check`: passed

## Findings

No actionable P0, P1, or P2 visual or interaction issue remains in the current
Status and Routes prototype. Placeholder destinations remain intentional.

The quick-route refinement replaces unbounded tonal hover rows with one 1px
hairline group boundary, an 8px group radius, and internal separators. Hover
changes emphasis without adding a new gray block; the selected row alone uses
the soft surface and checkmark. The active sidebar tab now has a 1px hairline
border reserved by a transparent default border. Browser-computed styles at
911 × 855 confirm both boundaries, correct last-row border removal, no body
overflow, and a clean console.

The subsequent boundary pass adds a complete 1px hairline to the tonal
connection surface. The active sidebar tab now uses the stronger `#d1d5db`
neutral outline and reduces its shadow to `0 1px 1px rgba(0,0,0,.02)`. Browser
computed styles at 911 × 855 confirm the connection surface has no shadow, the
active tab uses the intended border and reduced shadow, and the page remains
free of overflow and console issues.

The primary-surface pass removes the tonal background from the connection
surface and uses the white canvas, one hairline, and a two-part low-opacity
ambient shadow. The active sidebar outline returns to the ordinary hairline.
Computed styles at 911 × 855 confirm the white background, `#e5e7eb` borders,
4%/2.5% primary shadow layers, no overflow, and no console issues.

The surface-control pass lightens the sidebar to `#f8f9fa` and removes the
traditional segmented-control trough from routing mode. The existing Base UI
ToggleGroup now presents three 30px surface buttons with 4px spacing. Computed
styles confirm a transparent and borderless group, transparent idle items, and
a selected white item with an 8px radius, hairline, and 5% low shadow. Selection
behavior remains semantic and functional; the checked state changes correctly,
with no overflow or console issues.

The status-action pass turns the passive sidebar label into a Base UI Button.
Healthy state uses the accessible `#2563eb` brand surface with explicit
`Connected` text. Inactive state reads `Proxy off`, settles to a transparent
background and border, and reveals its hairline only on hover. Warning and error
state selectors are reserved in the same component vocabulary. Browser checks
at 1024 × 768 confirm the 144 × 36px button, 8px radius, synchronized main
switch state, no overflow, and a clean console.

Routing mode now follows the shadcn Button Group composition: a `role="group"`
wrapper with three joined 30px Base UI Buttons, shared outline boundaries, and
`aria-pressed` selection. Browser interaction changed Rule to Global and back,
confirming the pressed state and restoring the default view.

The latest traffic pass lightens the active sidebar button from `#2563eb` to
`#2f6fdc`, replaces the generic connection label with active node plus rotating
download/upload rate, and hides the rate through a sidebar container query at
150px and below. Download and upload session rows now place synchronous,
offline-bundled Recharts area sparklines between label and value. The charts
have no axes, grid, markers, or background and use a radial mask to fade all
four edges.

The Vite production build and DESIGN.md lint pass. Browser automation could not
attach to the currently open in-app preview after this pass, so visual review of
the new sparklines remains pending in the user's live preview. The workspace
and primary-surface shadow tokens are intentionally unchanged while awaiting
confirmation of the researched lower-elevation direction.

final result: passed
