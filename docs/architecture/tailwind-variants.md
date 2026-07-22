# Tailwind Variants styling ownership

Production reusable components use the original `tailwind-variants` build in
`@mish/ui`. The configured `@mish/ui/tv` entry point is the only direct
`tailwind-variants` consumer and keeps `tailwind-merge` as the single merge
boundary for component recipes and the exported `cn` helper. Its font-size
class group recognizes Mish's semantic `text-title`, `text-body`,
`text-metadata`, `text-caption`, `text-label-small`, and `text-micro` utilities
before the broader text-color matcher. Caller typography overrides therefore
remain last without conflicting with `text-fg` or other foreground colors.

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

Long recipes use `tailwind-variants` `cx()` to group complete static utility
literals into readable lines. `cx()` only concatenates those groups; the TV
recipe remains the single `tailwind-merge` boundary, including the final caller
`className` override.

Semantic custom utilities are used when a valid theme-generated class belongs
to an ambiguous `tailwind-merge` group. For example, `spinner-border` consumes
the named spinner border-width token without being mistaken for a border color
and removed next to `border-current`. Theme-generated typography utilities keep
their native Tailwind `text-*` shape because the configured merge entry point
registers their exact semantic names in the font-size group.

`pnpm check:styles` enforces those boundaries. It rejects interpolation inside
recipes or Tailwind class fragments, requires every package that imports
`tailwind-variants` to have an explicit `@source` entry, and verifies that every
CSS Module class is consumed through its imported mapping.

Recipes consume mapped theme values through named utilities such as
`bg-canvas`, `text-fg`, `text-muted-foreground`, `rounded-md`, and
`shadow-float`. Typography and foreground colors both retain Tailwind's native
`text-*` naming, with their roles disambiguated by the centralized merge
configuration. Recipes do not bypass the theme with `bg-(--color-canvas)`, raw
`--mish-*` variables, or
equivalent indirect shorthands. Surface-scoped values such as the material-aware
sidebar background are exposed as named theme colors while their runtime CSS
variables remain the source of truth.

Repeated root-state selectors use named CSS-first variants. `runtime-desktop:`,
`runtime-mobile:`, and `theme-dark:` replace inline `html[data-*]` arbitrary
ancestor selectors while preserving the same document-root state contract.

Simple fixed geometry follows the 4px Tailwind spacing base, including exact
fractional steps (`h-5.5` for 22px, `gap-1.75` for 7px, and `px-2.25` for 9px).
Do not round preserved geometry to a nearby whole step. Repeated responsive
thresholds, typography levels, component radii, color mixes, and other semantic
values use named theme tokens. Arbitrary values remain valid for structural
grid templates, `min()`/`calc()` viewport containment, safe areas, runtime Base
UI positioning variables, custom-property-driven spans, and the documented CSS
Module effects.

ARIA and Base UI `data-*` attributes remain the behavior and accessibility
source of truth. Recipes may target those attributes for presentation, but must
not replace pressed, disabled, focus, highlighted, loading, or validation
semantics with visual-only state.

## CSS boundaries

`apps/web/src/styles.css` is limited to these explicit owners:

- startup failure markup that must render before React can mount;
- document roots, resets, default focus treatment, and native material root
  transparency;
- the route focus manager's heading reset and the static `user-authored-label`
  utility;
- the semantic `spinner-border` utility whose name avoids an ambiguous
  `tailwind-merge` group;
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

- `status-page.module.css` owns the traffic curve column's edge-fade mask;
- `app-shell.module.css` owns the proxy control's multi-layer radial material;
  and
- `status-shimmer.module.css` owns WebGL canvas containment.

Ordinary layout, spacing, typography, responsive behavior, and component state
must not be added to those modules.

The migration bundle record, automated evidence, and final hands-on matrix live
in [`../quality/tailwind-variants-acceptance.md`](../quality/tailwind-variants-acceptance.md).
