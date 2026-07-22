# Tailwind Variants styling ownership

Production reusable components use the original `tailwind-variants` build in
`@mish/ui`. Its default `tailwind-merge` integration is the single merge
boundary for component recipes and the exported `cn` helper.

## Ownership

- `packages/design-tokens` owns semantic CSS variables and Tailwind theme
  mappings.
- `packages/ui` owns reusable component recipes, their public visual variants,
  and Base UI wrappers.
- `apps/web` owns page composition. A small local composition may use complete,
  static utility literals. Stateful or multi-slot page-local composition may use
  a local recipe when that is easier to read.

Component callers pass `className` as the final recipe input. Consequently, an
intentional page-level Tailwind utility override wins a conflicting primitive
utility. Repeated overrides must become a named semantic variant rather than a
new selector contract.

## State and source detection

Recipes never construct Tailwind utilities dynamically. Each utility is a
complete literal in source so Tailwind v4 can detect it in `@mish/ui`, which is
scanned by `apps/web/src/styles.css` through `@source`.

`pnpm check:styles` enforces those boundaries. It rejects interpolation inside
recipes or Tailwind class fragments, requires every package that imports
`tailwind-variants` to have an explicit `@source` entry, and verifies that every
CSS Module class is consumed through its imported mapping.

ARIA and Base UI `data-*` attributes remain the behavior and accessibility
source of truth. Recipes may target those attributes for presentation, but must
not replace pressed, disabled, focus, highlighted, loading, or validation
semantics with visual-only state.

## CSS boundaries

`apps/web/src/styles.css` is limited to these explicit owners:

- startup failure markup that must render before React can mount;
- document roots, resets, default focus treatment, and native material root
  transparency;
- the route focus manager's heading reset and the static
  `user-authored-label` utility;
- reduced-motion, browser/desktop text selection, WebKit drag suppression, and
  desktop cursor/pressed feedback policies that intentionally cross component
  boundaries; and
- the retained `DestinationPage` styling reference, which is not imported by a
  production route and is intentionally outside this migration.

Desktop/browser and native mobile shells remain separate components with local
recipes. Runtime-, theme-, viewport-, container-, `data-*`-, and ARIA-dependent
presentation belongs to those recipes rather than new global selectors.

CSS Modules are a bounded escape hatch for keyframes, complex gradients, masks,
filters, canvas/WebGL containment, or awkward platform selectors. Every module
class must be referenced through its imported mapping (`styles.name` or
`styles["kebab-name"]`); raw module class strings and module-global selectors
are not supported.

The current exception inventory is deliberately small:

- `traffic-sparkline.module.css` owns the sparkline's multi-layer mask;
- `app-shell.module.css` owns the proxy control's multi-layer radial material;
  and
- `status-shimmer.module.css` owns WebGL canvas containment.

Ordinary layout, spacing, typography, responsive behavior, and component state
must not be added to those modules.

The migration bundle record, automated evidence, and final hands-on matrix live
in [`../quality/tailwind-variants-acceptance.md`](../quality/tailwind-variants-acceptance.md).
