# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Treat the web UI as an offline asset embedded in the Tauri client. Core screens,
controls, charts, icons, and styles should ship synchronously with the
application bundle rather than lazy-loading behind runtime placeholders.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Prototype design direction

- Use the Cal.com design system at `https://getdesign.md/cal/design-md` as the
  selected token and component-language reference. Adapt its neutral product UI
  patterns to macOS; do not copy its marketing layouts or branding.
- Use Base UI primitives for stateful behavior wherever they fit. The current
  mappings are Tabs for workspace navigation, Switch for the primary connection
  state, Button for the sidebar proxy action and routing-mode actions,
  ToggleGroup and Toggle for quick-route selection, Popover for diagnostics,
  and Tooltip for icon-only controls.
- Aim for a restrained, native-feeling macOS utility instead of a generic
  dashboard.
- Use only three visible type sizes: 13px metadata, 14px product UI, and 22px
  page titles. Prefer weight, color, spacing, and alignment for hierarchy.
- Keep most content on one layer. Use inset row separators for lists and reserve
  complete borders for real grouped controls.
- Pair a faint border with a subtle shadow only for elevated, interactive
  surfaces such as a primary connection control, popover, or focused field.
- Keep the primary connection surface shadow especially light and use a 10px
  radius. Sidebar navigation text and selected-row fills should be slightly
  muted rather than high contrast.
- Structure the window as exactly two visual layers: a muted gray base holding
  the left navigation, and one Arc-like foreground workspace card on the right
  that contains both the toolbar and page content. Inset that workspace about
  10px from the top, right, and bottom with a faint border, 12px radius, and low
  panel elevation. Do not add another card boundary around Overview itself.
  System detail belongs in diagnostics instead of a persistent right column.
- Keep the navigation sidebar directly on the base layer without a hard divider
  or its own edge shadow. The foreground workspace card supplies the separation.
  Prefer semantic surface, text, line, status, and elevation tokens over
  component-specific color names.
- Use a compact 164px task sidebar rather than either a wide Clash-style panel
  or an ambiguous icon dock. Name destinations after user tasks: Status,
  Routes, Profiles, Traffic, and Events. Each 36px row pairs an icon with a
  visible 14px label.
- The Status view is a compact network workbench, not a centered configuration
  form. The sidebar proxy control owns connection state and the primary
  start/stop action. Keep the page itself flat: profile selection belongs in the
  toolbar, routing mode uses one compact control row, and policy groups sit next
  to session activity when width permits.
- Avoid the common proxy-client pattern of Connection, Routing, and Session as a
  long vertical stack of labeled rows. Lead with the user's network outcome and
  progressively disclose implementation details.
- Avoid gradients, glassmorphism, bento cards, pill overload, decorative
  charts, and excessive rounded containers.
- Treat repeated interactive choices as one grouped control with a complete
  hairline boundary and internal separators. Do not present them as unbounded
  rows that each gain a large gray hover block. Sidebar active tabs use a thin
  neutral border in addition to their white selected surface.
- Do not repeat the connection outcome in a large main-page status card. Active
  sidebar tabs use the ordinary hairline and only a nearly imperceptible shadow,
  so the outline carries the selected state.
- Use the lighter `surface-soft` token for the sidebar base. Routing mode uses
  the shadcn Button Group composition with joined Base UI buttons, shared
  hairlines, and an `aria-pressed` selected state.
- Name the bottom action `ProxyControlButton` ("proxy control button" in design
  discussion). Align its icon and copy to the exact icon and text columns used by
  the navigation rows. When inactive it shows a power icon and "启动代理" on a
  transparent surface with a quiet gray hairline. When healthy it shows the Wi-Fi
  icon and selected node on the animated brand surface. Healthy hover and keyboard
  focus keep the surface unchanged while crossfading in place to a circle-X icon
  and "关闭代理". Reserve warning and error surfaces for matching non-healthy
  states. Do not mount the decorative canvas while disconnected.
- Session download and upload rows may use a compact Recharts area sparkline
  between label and value. Keep it axisless, gridless, markerless, backgroundless,
  softly filled to the baseline, and faded on all four edges. Group the Session
  rows inside the same complete hairline and 8px-radius container language as
  the policy-group list while keeping both section headings open on the page.
  De-emphasize the textual rate and hide the sparkline when its section becomes
  too narrow. Keep the adjacent section title and description on one line when
  space permits.
- Replace the context-free Quick routes list with the five policy groups that
  have the highest cumulative connection counts for the active profile. Count
  each Mihomo connection ID once, intersect its chain with known groups, and
  keep the resulting shortcut group-scoped. Use the counts only for ranking;
  they are not meaningful display data. Show the selected child and measured
  latency beneath the group name, plus a small badge containing the number of
  available nodes. Do not infer or display a node's geographic location. Open a
  reusable Base UI `ProxyPickerDialog` from each row to select a child for that
  specific group rather than navigating away or implying one globally active
  node.
- Preserve emoji supplied in node and policy-group names. Mock data should model
  them as a separate field: regional flags for nodes and semantic emoji for
  groups. Apply saturation to the complete user-authored label layer so mixed
  text and emoji work in any order without rewriting input; neutral text remains
  visually unchanged. Use 40% saturation for all user-authored labels. Render
  mock markers in fixed columns with an explicit 5px visual gap: 15px for
  semantic group markers and a lower-contrast 11px for regional flags.
  Keep a clean no-emoji fallback and never infer geography when the
  configuration does not provide it.
- The healthy sidebar action may use a restrained full-area WebGL water
  distortion to signal live state. Build exponential sine waves with analytical
  derivatives and use each octave's derivative to drag the domain of the next
  octave. Combine a broad, stronger primary field with a finer, softer cross-wave
  field; give them distinct wave shapes, scales, directions, and horizontal
  speeds before combining their normals. Keep the secondary field subordinate
  so the result does not resemble marble. Compose the material explicitly from
  top to bottom as fast diagonal highlight, slow sky-blue disturbance, faster
  deep-blue disturbance, a static watercolor layer, and a sky-shifted blue
  DOM background fallback. Build the static layer from overlapping, softly
  bleeding blue fields with visible tonal contrast: deep blue at the edge and
  a brighter sky-blue inner field. Healthy hover keeps the animated material at
  its resting brightness because the icon and copy already communicate the
  destructive action. The broad
  highlight may travel horizontally faster than both water fields, but it must
  remain blue, soft-edged, and independent from the surface normal. Do not expose FBM, noise
  density, white glare, a moving highlight blob, a narrow laser stripe, or
  frame-random flicker. Keep it clipped, low-alpha, low-power, paused while
  hidden, and static under reduced motion; absence of WebGL must not affect the
  button. Cap actual WebGL draws at 30, 45, or 60 FPS using a small, explainable
  device-capability heuristic instead of rendering at the display refresh rate.
- Decorative traffic sparklines must not expose Recharts' application focus
  layer. Fade all four edges visibly and soften the adjacent direction labels
  so the textual rate remains dominant.
- The Session group shows live upload and download rates, cumulative uploaded and
  downloaded bytes, active connection count, Mihomo memory in use, and uptime.
  Integrate cumulative bytes beneath the Downloaded and Uploaded labels instead
  of allocating another pair of cells. Give the direction arrows the same blue
  and green semantic colors as their sparklines and slightly increase the live
  traffic row height to preserve breathing room.
  Model live and total traffic after `/traffic` (`up`, `down`, `upTotal`,
  `downTotal`) and memory after `/memory` (`inuse`). Pair compact stable metrics
  within the grouped outline instead of creating a dashboard card grid.
- Include active rules in the paired Session metrics. Read `/rules` in the real
  client and ignore entries explicitly marked disabled when presenting the
  effective count.
- Fill the remaining Status-page space with one full-width grouped service
  latency list rather than KPI tiles or a bento grid. Default to Google, GitHub,
  Cloudflare, Baidu, Apple, and Microsoft, showing a borderless semantically colored icon, title,
  and latency. Use three columns at comfortable desktop widths and one column
  when constrained. Keep the probe URL in
  the editor instead of showing it during normal monitoring. Users can
  add, edit, or delete entries through one reusable Base UI Dialog and restore
  the complete default set from a Base UI Menu. A result describes the configured
  endpoint probe only; do not imply it is the latency of a globally active node.
- Build repeated grouped surfaces with reusable `SectionGrid` and
  `SectionGridItem` components. The container owns a real 1px hairline, 8px
  clipped radius, and stable 1px internal gaps using `hairline-soft`. Items may
  span columns or rows so the
  same primitive covers vertical lists, horizontal partitions, and mixed
  grids. Do not simulate the outer border with padding and a background because
  child backgrounds flatten the visible corners.
- Put traffic-capture configuration and Routing mode in the same two-row
  `SectionGrid`. Traffic capture uses independent Base UI pressed-state buttons
  labeled exactly “系统代理” and “增强模式（TUN）”; the adjacent question button
  is the final item in the same button group and opens a Base UI Dialog
  explaining the difference. Stack the two control rows vertically, but keep
  each row's label and controls on one line. Let labels use their natural width,
  then left-align controls with a consistent 24px gap. `ProxyControlButton`
  remains the aggregate master control: stop disables both, and a fresh start
  enables System Proxy by default.
- The Status toolbar contains one Base UI profile menu showing the active
  configuration. Keep it visually quiet because profile switching is infrequent.
  Do not use that position for a supposedly global active node or a persistent
  diagnostics action. Normal health stays quiet; surface diagnostics only from
  Events or contextual failure states.
