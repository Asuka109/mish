# Prototype Validation

## Artifact status

`sketch/` is an interactive, offline-bundled React reference for the macOS-first
Status experience. It validates layout, component anatomy, responsive behavior,
keyboard semantics, and selected micro-interactions. It does not validate the
desktop bridge, Mihomo core compatibility, persistence, Tauri window behavior,
status-bar menus, native privileges, or release packaging.

`sketch/` remains a retained design and interaction reference. Production code
must not import from it or treat its JavaScript fixture shape as a DTO. The
production TypeScript boundary and validation matrix live in
[`production-web-validation.md`](production-web-validation.md).

## Implemented reference surface

- Two-layer desktop shell with compact task sidebar and inset workspace.
- Base UI navigation, menus, dialogs, buttons, tooltips, and pressed states.
- `ProxyControlButton` state transition and adaptive decorative WebGL material.
- Routing and capture controls.
- Session traffic, totals, metrics, and responsive sparklines.
- Five ranked policy-group rows with a reusable group-scoped proxy picker.
- Configurable service-monitor editor and Restore defaults behavior.
- Placeholder destinations for Profiles, Traffic, Events, and Settings.

## Mocked or incomplete

| Area               | Current state                       | Production requirement                                      |
| ------------------ | ----------------------------------- | ----------------------------------------------------------- |
| Mihomo core data   | Static fixtures                     | Typed DTOs from the desktop bridge                          |
| Commands           | React state only                    | Authenticated JSON-RPC commands with error states           |
| Group usage        | Fixture counts                      | Profile-scoped deduplicated observation and persistence     |
| Service probes     | Fixture latency                     | Bounded desktop-bridge probes with explicit route policy    |
| Profiles           | Local fixture menu                  | Import, update, validation, persistence, and fingerprinting |
| Native shell       | Browser-shaped preview              | Tauri window, tray, capabilities, lifecycle, and signing    |
| Sidebar vibrancy   | Solid fallback                      | Native macOS material and accessibility fallback            |
| Other destinations | Placeholders or partial Routes view | Feature-specific product and data contracts                 |

## Required checks for prototype changes

Run from `sketch/` unless noted:

```sh
pnpm run build
npx @google/design.md lint ../DESIGN.md
git diff --check
```

For visible component changes, also verify:

- 1024×768 and a narrow layout where Session and Groups stack;
- 1×, 1.5×, and 2× device pixel ratios for icon and hairline artifacts;
- pointer hover, keyboard focus, pressed state, and repeated transitions;
- no horizontal overflow and no clipped outer radii;
- reduced-motion behavior and a WebGL-unavailable fallback;
- labels containing mixed scripts, emoji, long names, and no inferred geography;
- service layouts at three columns and one column; and
- a clean browser console and accessibility tree.

## Native-shell validation gate

When the Tauri shell exists, validate separately:

- status-bar commands and window/browser opening;
- active and inactive window appearance;
- Reduce Transparency and reduced-motion preferences;
- light and dark system appearance;
- sleep, wake, core restart, and browser reconnect behavior;
- system proxy and TUN permissions, failure recovery, and mutual independence;
- process and WebGL energy use over an extended idle period; and
- signed offline builds with no unexpected runtime network assets.

## Performance baseline

The current sidebar water material uses a low-power WebGL context, caps device
pixel ratio at 2, pauses when hidden, and chooses 30, 45, or 60 FPS from a small
capability heuristic. An Apple M1 Max development measurement recorded roughly
0.526 ms per DPR-2 draw for the button-sized canvas. This is a development
reference, not a cross-device budget. Re-measure on representative Intel and
Apple Silicon Macs inside the real Tauri compositor before release.

## Definition of done for production integration

A Status feature is complete only when its product semantics, DTO contract,
loading and failure states, keyboard behavior, responsive layout, and relevant
native capability have all been verified. A visually functional mock alone is
not completion.

Part 1 production migration does not change this prototype definition of done.
The prototype may remain runnable even when production adds stricter typing,
routing, tests, and adapter boundaries.
