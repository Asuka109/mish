---
version: beta
name: Mihomo Cal Workbench
description: A Cal.com-derived neutral design system adapted for a compact macOS network utility.
colors:
  primary: "#111111"
  ink: "#111111"
  ink-active: "#242424"
  body: "#374151"
  muted: "#6B7280"
  muted-soft: "#898989"
  canvas: "#FFFFFF"
  surface-soft: "#F8F9FA"
  hairline-soft: "#F3F4F6"
  hairline: "#E5E7EB"
  accent: "#3B82F6"
  brand: "#2F6FDC"
  brand-hover: "#2864C8"
  brand-foreground: "#F8FAFF"
  success: "#10B981"
  traffic-download: "#2F6FDC"
  traffic-upload: "#2F855A"
  warning: "#B45309"
  error: "#DC2626"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Helvetica Neue, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  metadata:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  app-shell:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.ink}"
    padding: "0px"
  workspace:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0px"
  sidebar:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.body}"
    typography: "{typography.body}"
    padding: "14px 10px 10px"
  navigation-item:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "36px"
  navigation-item-idle:
    backgroundColor: "{colors.hairline-soft}"
    textColor: "{colors.body}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "36px"
  status-surface:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "20px 24px"
  secondary-control:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0px 16px"
    height: "40px"
  secondary-control-hover:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.ink-active}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "40px"
  input-placeholder:
    backgroundColor: "{colors.muted-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.metadata}"
    rounded: "{rounded.md}"
    height: "40px"
  focus-indicator:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "2px"
  positive-status:
    backgroundColor: "{colors.success}"
    textColor: "{colors.ink}"
    typography: "{typography.metadata}"
    padding: "0px"
  metadata:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted}"
    typography: "{typography.metadata}"
    padding: "0px"
  separator:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.body}"
    height: "1px"
  grouped-list:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0px"
  status-button-healthy:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.brand-foreground}"
    typography: "{typography.metadata}"
    rounded: "{rounded.md}"
    padding: "0px 10px"
    height: "36px"
  status-button-healthy-hover:
    backgroundColor: "{colors.brand-hover}"
    textColor: "{colors.brand-foreground}"
    typography: "{typography.metadata}"
    rounded: "{rounded.md}"
    padding: "0px 10px"
    height: "36px"
  status-button-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.brand-foreground}"
    typography: "{typography.metadata}"
    rounded: "{rounded.md}"
    padding: "0px 10px"
    height: "36px"
  status-button-error:
    backgroundColor: "{colors.error}"
    textColor: "{colors.brand-foreground}"
    typography: "{typography.metadata}"
    rounded: "{rounded.md}"
    padding: "0px 10px"
    height: "36px"
  button-group-item:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted}"
    typography: "{typography.metadata}"
    padding: "0px 12px"
    height: "30px"
  button-group-item-selected:
    backgroundColor: "{colors.hairline-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.metadata}"
    padding: "0px 12px"
    height: "30px"
  traffic-sparkline-download:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.traffic-download}"
    height: "34px"
  traffic-sparkline-upload:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.traffic-upload}"
    height: "34px"
---

# Design System: Mihomo Cal Workbench

## Overview

This system adopts the neutral product language documented in the
[Cal.com DESIGN.md](https://getdesign.md/cal/design-md) and adapts it to a
long-running macOS utility. It keeps Cal's disciplined monochrome hierarchy,
4px spacing rhythm, quiet hairlines, sparse elevation, and compact controls.
It does not copy Cal's marketing layouts, display typography, or large section
spacing.

The application has exactly two visual layers: a lightly tinted window base containing
the navigation and one inset white workspace containing the toolbar and active
page. The default status screen presents the user's outcome through the sidebar
proxy control, then exposes the active profile, routing mode, frequently used
policy groups, and session activity without repeating status in a dashboard card.

## Colors

Use ink and neutral gray for almost all structure. Use the accent blue for focus
and the deeper brand blue for the compact proxy-active control. Success,
warning, and error colors communicate network state; they must always be paired
with text. The sidebar and exposed app-shell margin share the lighter
surface-soft neutral rather than splitting into two nearby gray fields. Avoid a
vertical color seam at the workspace edge.

## Typography

Use the macOS system font stack. Keep the visible scale to 13px metadata, 14px
product UI, and 22px page titles. Use 600 only for page titles and section
headings; ordinary controls use 500. Use tabular figures for latency, rates,
counts, and elapsed time.

## Layout & Spacing

Use a 4px base rhythm. The navigation is 164px wide: large enough for plain
task labels but much smaller than a proxy-dashboard sidebar. Navigation rows
are 36px high. Inset the foreground workspace 10px from the top, right, and
bottom. Content gutters are 24–32px. Keep the Status page below 1080px wide so
related values remain visually connected on large windows.

## Elevation & Depth

The workspace uses a hairline and a faint panel shadow. Ordinary sections stay
flat and use whitespace plus single-pixel separators. Grouped policy and session
rows use one complete hairline without elevation. Only menus, dialogs, popovers,
and tooltips use a noticeable floating shadow.

On macOS, the exposed sidebar may use the system's native vibrancy material so
the desktop or windows behind the application contribute to the surface. This
is a native window-compositor effect, not CSS glassmorphism: the Tauri shell
must apply an appropriate macOS window effect and make only the matching WebView
region transparent. Keep the foreground workspace opaque. The ordinary browser
client and unsupported platforms use the existing `surface-soft` sidebar as the
deterministic fallback; never simulate desktop translucency with a decorative
gradient or a captured wallpaper. Defer this material until the real Tauri
window exists, because the standalone Web preview cannot validate behind-window
sampling, window activation, accessibility transparency settings, or energy
behavior.

## Shapes

Use 12px for the foreground workspace, status surface, and popovers; 8px for
navigation, fields, buttons, and grouped controls; 6px for selected segments
and tooltips. Full rounding is limited to switches and status dots.

## Components

Use Base UI primitives for stateful, accessible behavior:

- `Tabs` owns primary workspace navigation and panels.
- Base UI `Button` owns each ranked policy-group shortcut.
- `ButtonGroup` composition with Base UI `Button` owns routing mode.
- Base UI `Button` owns the sidebar `ProxyControlButton` start/stop action.
- Base UI `Menu` owns active-profile switching in the toolbar.
- A `ButtonGroup` composition owns the independent System Proxy and TUN capture
  toggles; an adjacent Base UI `Dialog` explains their tradeoffs.
- Base UI `Menu` and `Dialog` own service-monitor management and editing.
- Base UI `Dialog` owns the group-scoped proxy picker.
- `Tooltip` labels icon-only expert controls.

Keep static rows, metrics, headings, and layout as semantic HTML. Base UI owns
behavior and accessibility, while this document owns visual styling. Buttons
are 40px high when presented as standalone actions; compact toolbar controls
may be 34px high.

Repeated interactive choices use a grouped-list treatment: one complete
hairline boundary and 8px radius around the collection, with single-pixel
internal separators. Hover changes text emphasis instead of painting each row
as a floating tonal block. Selection may use the soft surface together with a
checkmark and stronger text. Sidebar tabs reserve a transparent 1px border and
reveal the hairline border in the active state so selection does not shift the
layout. Use the ordinary hairline for this active border and keep its shadow
almost imperceptible; the border, not elevation, should carry selection.

Build grouped surfaces with the reusable `SectionGrid` and `SectionGridItem`
components. `SectionGrid` owns one real 1px hairline border, an 8px clipped
radius, and stable 1px internal gaps using the softer hairline token; never
simulate the outer border with padding or
a background because child surfaces will visually flatten the corners. The
grid accepts one or more columns, while items can span rows or columns, so the
same anatomy supports vertical lists, horizontal divisions, and mixed layouts.

Compact routing choices use the shadcn Button Group composition with Base UI
buttons. The three outline buttons form one joined 30px control, share internal
hairlines, and expose the current mode with `aria-pressed`. Hover uses
surface-soft; the selected button uses hairline-soft and stronger ink.

The sidebar `ProxyControlButton` is a 36px Base UI button aligned to the same icon
and text columns as navigation. Healthy proxy state uses the brand surface and
shows a Wi-Fi icon plus the selected node. Hover and keyboard focus keep the
material unchanged and crossfade in place to a circle-X icon plus "关闭代理". Inactive state
shows a power icon plus "启动代理" on a transparent surface with a quiet hairline.
Connecting and error states use the warning and error surfaces with matching text
labels, so color never carries meaning alone. Healthy state may add one restrained,
diffuse blue shadow; keep it weaker than menu and dialog elevation.

When healthy, the status action may render a low-alpha water-like WebGL
distortion across the entire brand surface. Build it from exponential sine
waves with analytical derivatives. Each octave uses its derivative to drag the
sampling position of the following octave, producing compressed crests,
stretched troughs, and continuous refractive folds. Shade from the resulting
height gradient. Keep the wavelength broad enough to avoid dense, sharp visual
noise, tint highlights pale blue rather than white, and translate the complete
surface steadily from left to right. Local wave evolution remains secondary to
this directional drift. Do not use FBM, noise density, or blurred light patches
as the visible material; they read as clouds rather than water. Never use an
isolated highlight or narrow laser stripe. Motion advances continuously without
frame-random flicker. The effect remains clipped to the button, uses a low-power
context, pauses while hidden, and falls back cleanly when WebGL is unavailable.
Reduced-motion users receive a static frame rather than continuous animation.

The Status page ranks the five most-used visible policy groups by cumulative
connection count. Counts are derived by deduplicating Mihomo connection IDs and
matching each connection chain against the current profile's known groups.
Rows always show both group name and currently selected child; they open a
group-scoped selector and never imply that a node is globally active. Persist
rankings per profile so switching configurations cannot mix unrelated groups.
Preserve user-supplied emoji as a leading part of node and group labels. Keep
the emoji and label as separate data fields, then render them in fixed marker
columns with an explicit 5px visual gap. Apply saturation to the complete
user-authored label layer so arbitrary text and emoji ordering works without
rewriting input; neutral text remains visually unchanged. Use 40% saturation
for all user-authored labels. Semantic group emoji use a restrained 15px
marker; regional flags use a smaller, lower-contrast 11px marker so they
do not turn labels into decorative prose. The client must not invent geography
when a name does not provide it.

Download and upload session rows may include a compact area sparkline between
the label and value. It has no chart background, axes, grid, markers, or text.
Use a 1.35px semantic line, a very low-opacity fill to the lower boundary, and
a clearly visible mask that fades all four edges into the row. Decorative
sparklines stay out of the accessibility tree and never receive a focus
outline; their adjacent textual rate labels remain the accessible source of
truth.

The Session grouped list integrates cumulative bytes below the Downloaded and
Uploaded labels, beside the live rate and sparkline. Their arrow icons use the
same semantic blue and green as the corresponding charts. It also shows Mihomo
memory in use, active connections, and uptime. Pair stable secondary metrics in
two-column rows to preserve density. Map the values to `/traffic`
(`up`, `down`, `upTotal`, `downTotal`) and `/memory` (`inuse`); `/connections`
may supply the same totals and memory alongside the active connection list.
Show the active rule count as another compact paired metric. Derive it from
`/rules` and exclude entries explicitly marked disabled instead of treating the
raw array length as universally effective.

Place configurable service-latency monitors in one full-width grouped list
below the policy-group and session columns. Use three columns at comfortable
desktop widths and one column when constrained. Each row contains a borderless,
semantically colored service icon, title, and measured latency; the probe URL
is shown only in the reusable editor dialog. Ship Google, GitHub, Cloudflare,
Baidu, Apple, and Microsoft as defaults, while
allowing add, edit, delete, and Restore defaults. Treat these values as endpoint
probe results, not proof of a globally active proxy route; the application layer
must choose and disclose the Mihomo probe target explicitly.

The toolbar profile selector is an infrequent configuration control. Keep its
icon, label, and caret muted until hover or focus so it does not compete with
Status-page controls.

Traffic capture uses two independent pressed-state buttons labeled “系统代理”
and “增强模式（TUN）”, because the capabilities are not mutually exclusive.
Use a nearly white pressed fill so state remains visible without turning the
compact group into a heavy gray control.
Place its button group and Routing mode as two vertically stacked rows in the
same `SectionGrid`. Within each row, keep the label and control on one line.
Let each row use the label's natural width, then left-align its controls with a
consistent 24px gap instead of reserving a fixed label column.
Include the question button as the final item in the traffic-capture button
group; it opens a concise explanation dialog.
The sidebar `ProxyControlButton`
remains the aggregate everyday control: stopping it disables both capture
paths, while starting from fully inactive enables System Proxy by default.

## Do's and Don'ts

### Do

- Lead with connection outcome and active route.
- Keep navigation labels visible and task-oriented.
- Use tonal surfaces for grouping and hairlines for repeated rows.
- Keep diagnostics progressively disclosed.
- Reserve shadows for the workspace and floating overlays.

### Don't

- Don't reproduce a Clash-style dashboard or configuration stack.
- Don't use a narrow icon dock that makes destinations ambiguous.
- Don't add nested bordered cards, persistent status inspectors, or bento grids.
- Don't mix unrelated gray families, radii, or shadow strengths.
- Don't copy Cal.com marketing sections into the desktop product.
