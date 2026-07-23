# Mish Product

## Register

product

## Users

People who run Mish continuously on macOS and later on other desktop and mobile
platforms. They need to control traffic capture, understand current activity,
switch policy-group selections, and investigate failures without learning the
Mihomo core's implementation details or navigating an administration dashboard.

## Product Purpose

Mish is a neutral technical tool for local traffic forwarding, configuration
management, and diagnostics. It provides a clear, trustworthy control surface
for a locally managed Mihomo core. The default view should make the aggregate
proxy state, capture paths, routing mode, live session activity, frequently used
policy groups, and endpoint reachability easy to scan. It must not invent a
single globally active node in Rule mode. Profiles, full group trees,
connections, events, and diagnostics remain available through progressive
disclosure.

## Brand Personality

Native, restrained, and exact. The interface should feel like a focused macOS
professional tool in the family of Codex, Xcode, Raycast, and Arc: quiet enough
to stay open all day, dense enough for experts, and familiar without imitating
another product's branding.

## Anti-references

Do not resemble the common Clash client template: a wide text sidebar followed
by a centered stack of connection, routing, and traffic form rows. Avoid generic
proxy dashboards, card grids, oversized status blocks, decorative charts,
glassmorphism, gradients, pill-heavy controls, and visibly generated AI slop.

## Design Principles

1. Lead with the user's current capture state and activity, not the Mihomo
   core's configuration model.
2. Make frequent actions spatially stable and compact; reveal expert detail near
   the object it explains.
3. Use the window as the main container and reserve cards for true elevation or
   temporary focus.
4. Prefer professional density with repeatable control rhythms over generous but
   wasteful dashboard spacing.
5. Make every status legible through wording, placement, and iconography in
   addition to color.
6. Preserve the Mihomo core's group-scoped model. Never turn a convenient
   shortcut into a false claim about one canonical route.

## Current Product Surface

The macOS-first Status experience and its interaction rules are specified in
[`docs/product/status-experience.md`](docs/product/status-experience.md). The
production React app implements the six desktop destinations. A browser must
authenticate with the running desktop app before those destinations render;
fixture adapters remain test-only. The Tauri composition supplies confirmed
native and Mihomo-backed capabilities. The fixture-backed `pnpm demo` entry is
the shared model and visual-validation surface, not runtime evidence. Exact Web
implementation claims live in
[`docs/quality/production-web-validation.md`](docs/quality/production-web-validation.md);
native readiness uses the target-specific quality documents.

## Accessibility & Inclusion

Target WCAG 2.2 AA contrast and keyboard operation. Maintain visible focus,
respect reduced-motion preferences, keep hit targets practical for pointer and
touch input, and never communicate connection health or selection through color
alone.
