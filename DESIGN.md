---
version: beta
name: Mish Cal Workbench
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
  brand-foreground: "#F8FAFF"
  success: "#10B981"
  success-text: "#047857"
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
  positive-status-text:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.success-text}"
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
    backgroundColor: "{colors.brand}"
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

# Design System: Mish Cal Workbench

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

Product behavior is specified in
[`docs/product/status-experience.md`](docs/product/status-experience.md). Reusable
component anatomy is specified in
[`docs/design/component-patterns.md`](docs/design/component-patterns.md). This
document remains authoritative for visual tokens and styling rules.

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

Prefer shadcn components backed by Base UI for stateful, accessible behavior.
Use a Base UI primitive directly only when the shadcn layer does not provide the
required behavior:

- `Tabs` owns primary workspace navigation and panels.
- shadcn `Button` owns policy-group rows, text actions, and the sidebar
  `ProxyControlButton`.
- shadcn `ToggleGroup` owns the exclusive routing mode. Two standalone shadcn
  `Toggle` controls own the independent System Proxy and TUN capture states.
- shadcn `DropdownMenu` owns profile switching and service-monitor management.
- shadcn `Dialog`, `Command`, and `Button` compose the group-scoped proxy picker.
- shadcn `Dialog`, `Field`, `Input`, and `AlertDialog` compose service editing.
- shadcn `Badge` owns compact child counts; `Tooltip` labels icon-only expert
  controls.

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
components. `SectionGrid` owns one real 1px hairline border, an 8px radius, and
stable 1px internal gaps using the softer hairline token. It does not clip
overflow by default; each item must constrain its own content and respect the
outer corner geometry. Never
simulate the outer border with padding or
a background because child surfaces will visually flatten the corners. The
grid accepts one or more columns, while items can span rows or columns, so the
same anatomy supports vertical lists, horizontal divisions, and mixed layouts.

Compact routing choices use shadcn `ToggleGroup` backed by Base UI. The three
outline buttons form one joined 30px control, share internal
hairlines, and expose the current mode with `aria-pressed`. Hover uses
surface-soft; the selected button uses hairline-soft and stronger ink.

The sidebar `ProxyControlButton` is a 36px shadcn button aligned to the same icon
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

The Status page shows five frequently used visible policy groups. Rows show the
complete group label, selected child, latency, and child-count badge; they open
a group-scoped selector and never imply that a node is globally active. Ranking
semantics belong to
[`docs/architecture/status-data-contracts.md`](docs/architecture/status-data-contracts.md).

Treat every user-authored group, node, profile, and service label as one opaque
Unicode string. Do not parse an emoji prefix or require separate emoji and text
fields. Apply 40% saturation to the complete user-authored label layer. Preserve
the input verbatim, provide a clean no-emoji case, and never invent geography
from a label.

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
core memory in use, active connections, effective rules, and uptime. Pair stable
secondary metrics in two-column rows to preserve density. Source mapping belongs
to [`docs/architecture/status-data-contracts.md`](docs/architecture/status-data-contracts.md).

Place configurable service-latency monitors in one full-width grouped list
below the policy-group and session columns. Use three columns at comfortable
desktop widths and one column when constrained. Each row contains a borderless,
semantically colored service icon, title, and measured latency; the probe URL
is shown only in the reusable editor dialog. Ship Google, GitHub, Cloudflare,
Baidu, Apple, and Microsoft as defaults, while
allowing add, edit, delete, and Restore defaults. Treat these values as endpoint
probe results, not proof of a globally active proxy route. Probe semantics and
security belong to
[`docs/architecture/status-data-contracts.md`](docs/architecture/status-data-contracts.md).

The toolbar profile selector is an infrequent configuration control. Keep its
icon, label, and caret muted until hover or focus so it does not compete with
Status-page controls.

Traffic capture uses two standalone shadcn `Toggle` controls labeled “系统代理”
and “虚拟网卡”, because the capabilities are not mutually exclusive. Explain
the TUN implementation detail inside the adjacent help dialog rather than in
the compact control label.
Give each control its own complete outline and radius. Use the same muted
pressed treatment as Routing mode whenever it is selected. A selected but
stopped mode keeps muted label and icon colors; a selected and running mode uses
a restrained green icon. Provide equivalent accessible state text so runtime
state does not depend on color alone.
Place Traffic capture and Routing mode as two vertically stacked rows in the
same `SectionGrid`. Within each row, keep the label and control on one line.
Let each row use the label's natural width, then left-align its controls with a
consistent 24px gap instead of reserving a fixed label column.
Place the question button beside the two traffic-capture toggles;
it opens a concise explanation dialog without appearing to be another capture
mode.
The sidebar `ProxyControlButton`
remains the aggregate everyday control: stopping it pauses every selected
capture path without clearing the selection, and starting it resumes the full
remembered combination. When no path is selected, starting selects and enables
System Proxy as the compatibility default.

## Do's and Don'ts

### Do

- Lead with capture state, routing controls, and observable activity.
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
