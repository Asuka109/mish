# Tailwind Variants migration acceptance

This document records the automated evidence and the final hands-on walkthrough
for the Issue #138 production styling migration. It does not apply to the
fixture-backed demo composition or the unmounted `DestinationPage` reference.

## Bundle comparison

The baseline was captured from the pre-migration production build. The candidate
was built at `23e01db` after integrating `main` through `01c3f4b` and resolving
the Profiles, pending-control, and typography-scale hands-on feedback.

| Production artifact    | Baseline raw / gzip | Candidate raw / gzip | Change raw / gzip |
| ---------------------- | ------------------- | -------------------- | ----------------- |
| Total emitted CSS      | 118.78 / 20.02 kB   | 124.77 / 20.92 kB    | +5.99 / +0.90 kB  |
| Primary application JS | 909.55 / 276.99 kB  | 926.67 / 282.32 kB   | +17.12 / +5.33 kB |

Candidate CSS is split into 124.12 kB of generated Tailwind and bounded global
root CSS and 0.65 kB of CSS Modules. The 5.0% raw and 4.5% gzip increases pay for
the canonical named theme mappings, exact fractional utilities, named
root-state variants, and generated responsive/container variants that replaced
indirect CSS-variable and arbitrary-value shorthands.

The primary JS increase is 1.9% raw and 1.9% gzip. It includes the TV recipes
and product changes integrated from newer `main`, notably authoritative
notification events, browser backend recovery, the configured route catalog,
and Highcharts-based status session curves. The candidate also emits a
423.16 kB application-shell chunk, a 4.52 kB notification-delivery chunk, and a
5.39 kB configured-route-catalog chunk. The application-shell increase is
primarily attributable to the upstream Highcharts session implementation. These
secondary chunks are listed for diagnosis but are not compared numerically
because the baseline used a different chunk graph.

## Automated evidence

- `pnpm check:styles` confirms complete static utilities, the explicit
  `packages/ui/src` Tailwind source, the three named runtime/theme variants, and
  mapped references for all three CSS Modules.
- The token audit reports zero production TSX references to raw `--mish-*`
  variables, indirect theme shorthands, or simple fixed-pixel arbitrary
  utilities. Exact flex, margin, scrollbar, overflow-wrap, transform-origin,
  animation-duration, easing, and semantic color-mix values use native utilities
  or named tokens. Structural grid templates, viewport `min()`/`calc()`
  containment, safe areas, and Base UI runtime variables remain bounded
  exceptions.
- Long TV recipes and static class lists are grouped with `cx()` using complete
  class literals. `cx()` performs concatenation only; the enclosing TV recipe
  remains the single `tailwind-merge` boundary and caller overrides remain last.
- All production recipes consume the configured `@mish/ui/tv` entry point. Its
  extended font-size group classifies the exact semantic `text-*` typography
  levels before the broader text-color matcher. The semantic levels conflict
  with one another and with native Tailwind font-size utilities, but not with
  `text-fg` or other foreground colors.
- `pnpm check:tokens` requires the canonical typography and color theme
  mappings, while focused merge tests cover semantic colors, semantic font
  sizes, native `text-sm`, and final caller overrides at the shared boundary.
- The final selector audit found no ordinary production component or page owner
  in global CSS. The remaining component-shaped rules belong only to the
  pre-mount startup failure and the documented, unmounted `DestinationPage`
  reference.
- TypeScript, lint, format, design-token, documentation, unit, browser, and
  production-build gates cover the candidate. The 47-file/312-test Web unit
  suite and 10-file/33-test Chromium suite exercise desktop, compact browser,
  and mobile-sized browser layouts.
- Browser computed-style evidence covers container layout, proxy material and
  override merging, notification wrapping/removal/hover/focus behavior, service
  monitor layout, dialog overlays, light/dark presentation, native material
  fallback, Profiles primary-action contrast, and subscription-card spacing at
  the reported 1057 × 689 viewport. It also verifies nonzero current-color
  spinner borders in the disabled pending states for both Launch Proxy and
  System Proxy, 13px Settings controls and descriptions, and the 14px/13px
  primary/secondary policy-group type scale.
- Unit and browser behavior retain Base UI `data-*`/ARIA state, keyboard focus,
  disabled/loading/selected/highlighted behavior, reduced-motion shimmer policy,
  and the distinct native mobile shell.

## Hands-on visual matrix

The user performs this walkthrough after all automated checks pass; no command
reruns are required.

| Surface                            | Inspect                                                                   | Expected result                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Desktop, light and opaque          | Status, Routes, Profiles, Traffic, Events, Settings at 1440 × 900         | Existing spacing, typography, borders, tables, cards, controls, and sidebar alignment are intact |
| Desktop minimum, dark and material | The same routes at 800 × 600; proxy healthy/hover; dialogs and popovers   | No light seams or opaque shell leaks; dark icons/backdrops and focus treatment remain legible    |
| Compact browser                    | All routes at 390 × 844 and 320 × 568                                     | Bottom navigation and toolbar remain usable; labels and page controls do not escape the viewport |
| Native mobile composition          | Home, Routes, Profiles, Activity children, and Settings                   | Separate top/activity/bottom navigation, safe areas, banner, and one-column domain grids remain  |
| Stateful controls                  | Toggle, segmented controls, selects, disabled/loading actions, row states | Visual state follows the underlying ARIA/Base UI state without behavior changes                  |
| Motion and text interaction        | Reduced motion, notification selection/copy, keyboard focus traversal     | Motion is reduced, user text remains selectable, and focus order/visibility remain correct       |
