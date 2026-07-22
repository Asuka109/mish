# Tailwind Variants migration acceptance

This document records the automated evidence and the final hands-on walkthrough
for the Issue #138 production styling migration. It does not apply to the
retained `sketch/` application or the unmounted `DestinationPage` reference.

## Bundle comparison

The baseline was captured from the pre-migration production build. The candidate
was built at `a2a67e6` after integrating `main` through `1c2c07d`.

| Production artifact    | Baseline raw / gzip | Candidate raw / gzip | Change raw / gzip |
| ---------------------- | ------------------- | -------------------- | ----------------- |
| Total emitted CSS      | 118.78 / 20.02 kB   | 121.96 / 20.50 kB    | +3.18 / +0.48 kB  |
| Primary application JS | 909.55 / 276.99 kB  | 917.04 / 279.12 kB   | +7.49 / +2.13 kB  |

Candidate CSS is split into 121.28 kB of generated Tailwind and bounded global
root CSS and 0.68 kB of CSS Modules. The 2.7% raw and 2.4% gzip increases pay for
the canonical named theme mappings, exact fractional utilities, and generated
responsive/container variants that replaced indirect CSS-variable and
arbitrary-value shorthands.

The primary JS increase is 0.8% raw and 0.8% gzip. It includes the TV recipes
and product changes integrated from newer `main`, notably the unified
notification delivery and configured route catalog. The candidate also emits a
139.83 kB application-shell chunk, a 3.75 kB notification-delivery chunk, and a
5.39 kB configured-route-catalog chunk. Those secondary chunks are listed for
diagnosis but are not compared numerically because the baseline used a different
chunk graph.

## Automated evidence

- `pnpm check:styles` confirms complete static utilities, the explicit
  `packages/ui/src` Tailwind source, and mapped references for all three CSS
  Modules.
- The token audit reports zero production TSX references to raw `--mish-*`
  variables, indirect theme shorthands, or simple fixed-pixel arbitrary
  utilities. Structural grid templates, viewport `min()`/`calc()` containment,
  safe areas, Base UI runtime variables, and complex color mixes remain bounded
  exceptions.
- `pnpm check:tokens` requires the canonical theme mappings and rejects a color
  and typography token that would generate the same utility name. Production
  CSS verifies that `text-body` owns the body type scale and `text-fg` owns the
  normal body foreground color.
- The final selector audit found no ordinary production component or page owner
  in global CSS. The remaining component-shaped rules belong only to the
  pre-mount startup failure and the documented, unmounted `DestinationPage`
  reference.
- TypeScript, lint, format, design-token, documentation, unit, browser, and
  production-build gates cover the candidate. The 41-file/279-test Web unit
  suite and 8-file/22-test Chromium suite exercise desktop, compact browser,
  and mobile-sized browser layouts.
- Browser computed-style evidence covers container layout, proxy material and
  override merging, notification wrapping/removal/focus behavior, service
  monitor layout, dialog overlays, light/dark presentation, and native material
  fallback.
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
