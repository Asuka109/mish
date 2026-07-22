# Demo Validation

## Artifact status

`pnpm demo` starts the fixture-backed production Web composition. It is the
shared surface for model, visual, responsive, accessibility, and interaction
validation without a running desktop bridge. It exercises the same React routes,
shared UI components, design tokens, and localization used by production.

Demo data is fictional. A successful demo interaction does not prove Mihomo
compatibility, persistence, Tauri window behavior, status-bar commands, native
privileges, system capture, or release packaging. Those claims require the
target-specific production and native quality gates.

## Start the validation surface

Run from the repository root:

```sh
pnpm demo
```

Pass Vite arguments through the root command when a fixed address is useful:

```sh
pnpm demo -- --host 127.0.0.1 --port 4173
```

## Model and visual validation

Use the running demo for screenshot-driven or browser-driven inspection. At a
minimum, verify the changed surface in English and Simplified Chinese, light and
dark appearance, the relevant desktop viewport, and 320 px and 390 px narrow
viewports. Exercise visible hover, focus, pressed, loading, empty, error, and
disabled states that the fixture composition exposes.

For interaction changes, also verify:

- keyboard order, visible focus, Escape behavior, and focus restoration;
- labels containing mixed scripts, emoji, and long names;
- no unintended wrapping, clipping, or horizontal overflow;
- reduced-motion behavior and non-color status communication; and
- a clean browser console and accessible names for interactive controls.

Record the exact route, locale, theme, viewport, fixture state, and observed
result with any captured evidence. Do not present demo fixture values as device,
network, Core, or native-runtime observations.

## Automated checks

Run the checks that cover the changed surface before relying on the demo:

```sh
pnpm check:types:ts
pnpm test:unit
pnpm test:browser
pnpm web:build
```

The demo complements automated verification; it does not replace it.
