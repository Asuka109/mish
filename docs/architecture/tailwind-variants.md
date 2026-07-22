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

ARIA and Base UI `data-*` attributes remain the behavior and accessibility
source of truth. Recipes may target those attributes for presentation, but must
not replace pressed, disabled, focus, highlighted, loading, or validation
semantics with visual-only state.

## CSS boundaries

Global CSS is retained for document roots and reset behavior, theme and native
material/runtime scopes, browser/desktop shell behavior, and intentionally
cross-document platform rules. It must not become the default owner of a
reusable primitive.

CSS Modules are a bounded escape hatch for keyframes, complex gradients, masks,
filters, canvas/WebGL containment, or awkward platform selectors. Every module
class must be referenced through its imported mapping (`styles.name` or
`styles["kebab-name"]`); raw module class strings and module-global selectors
are not supported.
