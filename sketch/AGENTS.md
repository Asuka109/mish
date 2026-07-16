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
  form. Use one white primary status surface for connection state, active route,
  routing mode, current throughput, and the power switch. Put quick route
  switching and session activity in flat, adjacent work sections beneath it.
- Avoid the common proxy-client pattern of Connection, Routing, and Session as a
  long vertical stack of labeled rows. Lead with the user's network outcome and
  progressively disclose implementation details.
- Avoid gradients, glassmorphism, bento cards, pill overload, decorative
  charts, and excessive rounded containers.
- Treat repeated interactive choices as one grouped control with a complete
  hairline boundary and internal separators. Do not present them as unbounded
  rows that each gain a large gray hover block. Sidebar active tabs use a thin
  neutral border in addition to their white selected surface.
- The main connection surface is the page's single primary element. Use a white
  canvas, complete 1px hairline, and very low ambient shadow rather than a gray
  tonal fill. Active sidebar tabs use the ordinary hairline and only a nearly
  imperceptible shadow, so the outline carries the selected state.
- Use the lighter `surface-soft` token for the sidebar base. Routing mode uses
  the shadcn Button Group composition with joined Base UI buttons, shared
  hairlines, and an `aria-pressed` selected state.
- Treat the bottom proxy status as an action, not a passive label. Its Base UI
  button is transparent with a quiet gray hairline when inactive and uses the
  brand blue when healthy. Healthy copy shows the active
  connection-state icon and node plus a rotating download or upload rate; hide
  the rate with a sidebar container query before it crowds the node. Reserve
  warning and error surfaces for matching non-healthy states. When disconnected,
  keep the button fully transparent with a quiet gray border and do not mount
  the decorative canvas.
- Session download and upload rows may use a compact Recharts area sparkline
  between label and value. Keep it axisless, gridless, markerless, backgroundless,
  softly filled to the baseline, and faded on all four edges. Group the Session
  rows inside the same complete hairline and 8px-radius container language as
  the policy-group list while keeping both section headings open on the page.
  De-emphasize the textual rate and hide the sparkline when its section becomes
  too narrow. Keep the adjacent section title and description on one line when
  space permits.
- Replace the context-free Quick routes list with the three policy groups that
  have the highest cumulative connection counts for the active profile. Count
  each Mihomo connection ID once, intersect its chain with known groups, and
  keep the resulting shortcut group-scoped. Use the counts only for ranking;
  they are not meaningful display data. Show the selected child and measured
  latency beneath the group name, plus a small badge containing the number of
  available nodes. Do not infer or display a node's geographic location. Open a
  reusable Base UI `ProxyPickerDialog` from each row to select a child for that
  specific group rather than navigating away or implying one globally active
  node.
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
  a brighter sky-blue inner field. Healthy hover should darken the complete
  animated material clearly rather than relying on its border alone. The broad
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
