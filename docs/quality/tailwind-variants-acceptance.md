# Tailwind Variants migration acceptance

This document records the automated evidence and the final hands-on walkthrough
for the Issue #138 production styling migration. It does not apply to the
retained `sketch/` application or the unmounted `DestinationPage` reference.

## Bundle comparison

The baseline was captured from the pre-migration production build. The candidate
was built at `0450952` after integrating `main` through `f9e0b3e`.

| Production artifact    | Baseline raw / gzip | Candidate raw / gzip | Change raw / gzip |
| ---------------------- | ------------------- | -------------------- | ----------------- |
| Total emitted CSS      | 118.78 / 20.02 kB   | 113.33 / 20.07 kB    | -5.45 / +0.05 kB  |
| Primary application JS | 909.55 / 276.99 kB  | 919.88 / 279.49 kB   | +10.33 / +2.50 kB |

Candidate CSS is split into 112.65 kB of generated Tailwind CSS and 0.68 kB of
bounded CSS Modules. Raw CSS fell by 4.6%; the combined gzip result is
effectively flat because the two assets compress independently.

The primary JS increase is 1.1% raw and 0.9% gzip. It includes the TV recipes
and product changes integrated from newer `main`, notably the unified
notification delivery and configured route catalog. The candidate also emits a
141.87 kB application-shell chunk, a 3.75 kB notification-delivery chunk, and a
5.39 kB configured-route-catalog chunk. Those secondary chunks are listed for
diagnosis but are not compared numerically because the baseline used a different
chunk graph.

## Automated evidence

- `pnpm check:styles` confirms complete static utilities, the explicit
  `packages/ui/src` Tailwind source, and mapped references for all three CSS
  Modules.
- TypeScript, lint, format, design-token, documentation, unit, browser, and
  production-build gates cover the candidate. The browser suite exercises
  desktop, compact browser, and mobile-sized browser layouts.
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
