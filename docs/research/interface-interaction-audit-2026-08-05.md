# Installed Interface Skill Suite Interaction Audit

> Archive: historical research record only; it is not current implementation
> authority.

Date: 2026-08-05

Issue: [#379](https://github.com/Asuka109/mish/issues/379)

Decision state: **awaiting maintainer confirmation; no production UI or follow-up Issue has been changed**

## Executive decision

**Verdict: Needs changes.**

The installed `better-interface` orchestrator and its six owner Skills were run
as a complete interaction review against Mish's current contracts, rendered Web
surface, representative state tests, and platform boundaries. The pass found two
new candidates:

1. **High — Browser Client navigation is covered below 600 CSS pixels.** The
   responsive shell puts the navigation and workspace into implicit grid
   placement because `grid-row-1` / `grid-row-2` do not generate the intended
   row placement. The workspace toolbar then covers the navigation's pointer hit
   area at 320px, 390px, and 599px. At 600px the desktop sidebar becomes usable
   again.
2. **Medium — eager Status and Routes loading copy is not announced.** The two
   visible provider-loading states have neither `role="status"` nor an owning
   `aria-busy` region, while their error states and the shared deferred-route
   loader do expose appropriate semantics.

The navigation defect is systemic enough to justify one bounded standalone
prototype. The loading announcement does not benefit from a visual prototype.
No production source, dependency, accepted #356 follow-up, or implementation
Issue is changed by this research delivery.

## Scope, authority, and method

`DESIGN.md` remains the product authority. The installed Skills are review
prompts, not a replacement design system. `better-interface` supplied the review
order and finding cap; the owner-domain order was:

1. `better-accessibility`;
2. `better-layout`;
3. `better-writing`;
4. `better-typography`;
5. `better-colors`;
6. `better-ui`.

The audit started from `origin/main` at
`1d9713b59ea131c4feb18cf1db7e63ab7ba3a12f`. Issue #379, every comment, the
latest Agent Brief, the accepted [#356 audit](interface-skill-suite-audit-2026-08-04.md),
and the current linked Issues were read before classification. An all-state PR
search found no equivalent #379 delivery.

Evidence labels used below:

- **Direct** — observed in the rendered browser surface or measured from its
  live DOM and hit testing.
- **Automated** — exercised by a current browser, simulated-host, or unit
  contract test.
- **Source** — verified at the owning component, provider, token, or platform
  boundary.
- **Unavailable** — the required host or device was absent; no direct claim is
  made.

## Surface and state matrix

| Surface                     | Empty / loading / error                                                                                                   | Disabled / pending / finalizing / success                                                                           | Overflow and navigation                                                                                                                             | Localization, theme, and input                                                                 | Evidence limit                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Desktop WebView**         | Automated and source: route suspense, Profiles empty, typed Status / Events failures                                      | Automated and source: capability descriptions, `aria-busy`, command notifications; finalizing remains owned by #381 | Desktop bundle and shared shell tests cover 800×600 minimum, route focus, overlays, and return focus                                                | Shared en/zh catalogs, light/dark tokens, mouse and keyboard contracts                         | The isolated `desktop:demo` built and launched, but its development binary was not exposed to the available accessibility controller. Direct WebView GUI inspection is **unavailable**, not claimed. |
| **Browser Client**          | Direct fixture startup and loaded routes; automated authentication, recovery, provider failure, and simulated-host states | Direct disabled capture affordance; automated pending, success, and notification states                             | Direct at 1280×720, 390×844, and 320×720. No horizontal document overflow. **Primary navigation is covered below 600px.**                           | Direct English/Chinese and light/dark switching; source and automated keyboard/focus contracts | A different development worktree already owned the managed runtime, so authenticated live data was covered by simulated-host tests rather than a second operational backend.                         |
| **Installed-mobile Web**    | Automated mobile Home, Routes, Settings, empty, loading, and error fixtures                                               | Automated native-capability, disabled, pending, and typed result contracts                                          | Source and automated five-destination shell, Activity subnavigation, progressive Back, deep links, portrait, landscape, and single-scroller layouts | Automated en/zh, light/dark, enlarged text, reduced motion, and keyboard contracts             | `scripts/list-devices.mjs` returned no physical device. The mobile build and required Appium doctor checks passed, but physical installed-app interaction is **unavailable**, not claimed.           |
| **Native platform effects** | Platform-owned bootstrap and lifecycle only                                                                               | Rust / platform state remains authoritative                                                                         | No Native persistent product chrome; the Web shell owns routes, Back, overlays, and focus                                                           | Native system text only where required                                                         | Product-navigation proposals for a second Native owner are not applicable after #387.                                                                                                                |

### State conclusions

- **Empty and error:** existing route-owned empty states and typed error identity
  are strong. Do not replace them with decorative illustrations or generic copy.
- **Disabled and pending:** Base UI primitives, explanatory descriptions, stable
  spinners, and typed capability boundaries are strong. Target geometry remains
  #380; capture finalizing remains #381.
- **Success:** the notification delivery registry and typed command results
  already prevent a generic toast layer from claiming success prematurely.
- **Overflow:** representative desktop, 320px, 390px, portrait, landscape,
  enlarged-text, and long-content tests show bounded product content. The new
  defect is navigation occlusion, not document overflow.
- **Navigation:** route changes focus the destination heading and restore route
  scroll positions. Installed mobile has a coherent five-destination Web shell.
  The Browser Client's intended bottom navigation is not actually reachable
  below 600px.

## Owner-domain matrix

| Skill owner       | Evidence-backed result                                                                                                                                                                                                                                                                                | Classification                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Accessibility** | Route headings receive programmatic focus after navigation; Base UI owns dialog, menu, select, and toggle semantics; current controls expose pending and disabled meaning. Eager Status and Routes provider-loading copy lacks a live status boundary.                                                | **New component-family finding F2**; focus styling stays with delivered #323.              |
| **Layout**        | Desktop grouping, compact 4px rhythm, section grids, body-only scrolling, and installed-mobile shell are strong. Browser shell row placement fails below 600px and covers the primary navigation.                                                                                                     | **New systemic finding F1** with bounded prototype. Flow-relative residue stays with #382. |
| **Writing**       | English and Simplified Chinese catalogs keep action labels concrete, errors near their owner, and platform capabilities explicit. User-authored labels remain opaque.                                                                                                                                 | **Existing strength**; no new finding.                                                     |
| **Typography**    | System fonts, six project-owned roles, tabular numeric treatments, wrapping tests, and 320px no-overflow measurement preserve the compact hierarchy.                                                                                                                                                  | **Existing strength**; no font or scale change.                                            |
| **Colors**        | Semantic hex tokens preserve role identity. Measured WCAG ratios include light muted/canvas 4.83:1, light muted/surface 4.59:1, light brand/canvas 4.74:1, dark muted/canvas 6.98:1, and dark brand/canvas 4.82:1.                                                                                    | **Existing strength**; WCAG 2.2 remains the gate, with no OKLCH rewrite.                   |
| **UI**            | Surface scopes, Base UI behavior, restrained opacity/transform motion, reduced-motion override, pinned icons, and lazy route composition are coherent. Build output retains the existing >700 kB entry-chunk warning, but no user-impact timing evidence supports a new optimization conclusion here. | **Existing strength / monitor only**; no dependency or animation proposal.                 |

## Findings

### F1 — High — Browser Client primary navigation is covered below 600px

**Owner:** shared Browser Web shell layout and navigation.

**Evidence:**

- `apps/web/src/components/app-shell.tsx:86-127` defines a two-row mobile shell,
  but uses `max-shell-mobile:grid-row-2` for the navigation and
  `max-shell-mobile:grid-row-1` for the workspace. The built CSS contains the
  valid `row-start-*` utilities but no generated rule for these `grid-row-*`
  class names.
- Direct 320px measurement reports `grid-template-rows: 0px 720px` and
  `grid-row: auto` for both the navigation and workspace. The six route-link
  centers hit the workspace header, toolbar title, theme control, or language
  control rather than their links. The seven-cell navigation also includes the
  Proxy control.
- Direct 390px and 599px measurement produces the same covered hit area. At
  600px the 164px sidebar returns and the Routes link center hits Routes.
- The document remains exactly viewport-width, so horizontal scrolling cannot
  recover the navigation.
- Existing #356 text said the Browser Client changed to a bottom layout. This
  deeper interaction pass supersedes that runtime conclusion with hit-testing
  evidence; it does not change #356's accepted ownership model.

**Impact:** pointer users on a narrow Browser Client cannot reliably leave the
current product route. Keyboard focus can still enter covered controls, which is
also misleading because focus may move through content hidden beneath the
toolbar. Desktop WebView is not affected because its minimum width is 800px;
installed mobile uses `MobileShell` instead.

**Prototype decision:** justified. The standalone artifact preserves the
desktop sidebar at 600px and above. Below 600px it compares the observed covered
seven-cell row with one candidate: five persistent destinations, grouping
Traffic, Rules, and Events under Activity to match the installed-mobile Web
information architecture. This is a review direction, not production code.
Target sizing remains explicitly outside the artifact's acceptance boundary and
owned by #380.

### F2 — Medium — eager provider-loading copy has no live status boundary

**Owner:** Status and Routes page loading presentation.

**Evidence:**

- `apps/web/src/pages/status-page.tsx:215-230` renders visible initial loading
  copy in a plain `div`; the following unavailable state correctly uses
  `role="alert"`.
- `apps/web/src/pages/routes-page.tsx:240-253` repeats the same asymmetry.
- `apps/web/src/app-routes.tsx:24-44` establishes the project pattern for
  deferred routes with an owning `aria-busy="true"` region and a delayed
  `role="status"` announcement.
- `apps/web/src/pages/mobile-routes-page.tsx:144` also exposes its visible
  loading state as `role="status"`.

**Impact:** after the startup placeholder is replaced but before the provider
snapshot arrives, screen-reader users may receive neither a loading announcement
nor a route heading. Visual users see the state. Error recovery is announced,
so the semantic gap is limited to the initial provider-loading interval.

**Prototype decision:** not useful. This is a semantic state contract, not a
visual direction. If accepted, a later implementation slice should select one
owner-level status pattern, cover both pages, and test that it does not create
duplicate announcements with the startup placeholder or deferred-route loader.

## Existing ownership and deduplication

| Topic observed during the pass                                           | Existing owner                                              | Decision in #379                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------- |
| Keyboard-only focus outlines and modality                                | [#323](https://github.com/Asuka109/mish/issues/323), closed | Delivered strength. Do not reopen or duplicate.                |
| 24px / 44px target geometry for narrow or coarse-pointer shared controls | [#380](https://github.com/Asuka109/mish/issues/380), open   | Excluded from F1 and the prototype acceptance boundary.        |
| Capture Pending → Finalizing → Error / Success feedback                  | [#381](https://github.com/Asuka109/mish/issues/381), open   | Existing owner; no new finalizing finding.                     |
| Physical-direction residue and logical geometry                          | [#382](https://github.com/Asuka109/mish/issues/382), open   | Existing owner; no broad rewrite.                              |
| Removal of Native persistent-shell product ownership                     | [#387](https://github.com/Asuka109/mish/issues/387), closed | Accepted boundary. The prototype remains Web-owned.            |
| Browser launch token falling through to PIN pairing                      | [#388](https://github.com/Asuka109/mish/issues/388), open   | Existing authentication owner; not reclassified as navigation. |

No equivalent open or closed Issue was found for F1 or F2. Per the confirmation
contract, this audit does **not** publish new implementation Issues before the
maintainer accepts or rejects the matrix.

## Rejected and non-applicable suggestions

1. **Reject universal 44×44 desktop controls.** It conflicts with the accepted
   compact desktop density and duplicates #380's input-aware scope.
2. **Reject Native persistent product navigation.** It would create a second
   owner for Web routes, Back, overlays, and focus after #387.
3. **Reject a hex-to-OKLCH token rewrite.** Current semantic pairs pass the
   measured WCAG gate; notation churn has no evidenced interaction outcome.
4. **Reject new font, icon, motion, or color runtime dependencies.** Existing
   platform fonts, pinned icons, CSS, tokens, and Base UI are sufficient.
5. **Reject global text selection and generic animation sweeps.** Mish
   deliberately restores selection for data, code, inputs, and notifications,
   and already suppresses motion for reduced-motion users.

The desktop entry-chunk warning is recorded but does not become product work
without a reproducible latency, interaction delay, or explicit performance
budget. Physical Android behavior is not inferred from Chromium tests when no
device is connected.

## Bounded prototype

Artifact:
[`designs/browser-client-narrow-navigation/index.html`](../../designs/browser-client-narrow-navigation/index.html)

Serve from the repository root:

```sh
pnpm --filter @mish/web exec vite "$PWD/designs/browser-client-narrow-navigation" \
  --host 127.0.0.1 --port 4180 --strictPort
```

Open `http://127.0.0.1:4180/`.

The artifact provides:

- stable `data-screen-label` values for the candidate and observed states;
- a candidate / observed-collision comparison;
- functional route selection, Activity subnavigation, and segmented state;
- desktop-sidebar behavior at 600px and above;
- five complete labels without horizontal overflow at 320px and 390px;
- keyboard-visible focus and a reduced-motion contract.

The artifact deliberately does not simulate authenticated backend data,
production component code, coarse-pointer target policy, Native chrome, or a
follow-up Issue decision.

## Verification record

| Command or check                                      | Result                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm desktop:dev`                                    | Desktop Web bundle built; operational launch stopped because another Mish development instance already owned the managed runtime. The existing instance was not terminated.                                                                                                                                                                                          |
| `pnpm desktop:demo`                                   | Isolated demo origin and Rust development binary built and launched; closed after the available accessibility controller could not identify the development app.                                                                                                                                                                                                     |
| `pnpm --filter @mish/web build:desktop`               | Passed; desktop bundle verifier confirmed mobile navigation modules are excluded and pinned icons are present. Existing >700 kB entry-chunk warning remains.                                                                                                                                                                                                         |
| `pnpm --filter @mish/web build:mobile`                | Passed. Existing >700 kB entry-chunk warning remains.                                                                                                                                                                                                                                                                                                                |
| `pnpm --filter @mish/web test:browser`                | Primary config: 26 passed files, 2 failed; 140 passed tests, 2 failed. One notification test timed out only in the full parallel run and passed 5/5 when rerun alone. One Settings-order test has a deterministic baseline expectation that omits the existing `切换后重启连接` row. The chained simulated-host command did not run after the primary non-zero exit. |
| Focused notification browser test                     | Passed: 1 file, 5 tests.                                                                                                                                                                                                                                                                                                                                             |
| Focused local-proxy feedback browser test             | Baseline failure retained: 3 passed, 1 failed because the expected list omits the current row. No unrelated test repair is included.                                                                                                                                                                                                                                 |
| `pnpm --filter @mish/web test:browser:simulated-host` | Passed: 1 file, 8 tests.                                                                                                                                                                                                                                                                                                                                             |
| Android device discovery and Appium doctor            | No connected device. UiAutomator2 required checks passed; optional bundletool / GStreamer checks are absent and not required for this Web audit.                                                                                                                                                                                                                     |
| Prototype at 1280px, 390px, and 320px                 | Passed visual, DOM, pointer, overflow, stable-label, and console inspection.                                                                                                                                                                                                                                                                                         |
| Core semantic token contrast calculation              | Representative ordinary-text pairs measured from 4.59:1 to 12.02:1.                                                                                                                                                                                                                                                                                                  |
| `pnpm check:pr`                                       | Passed: Android and cross-platform authority, CI policy, generated catalogs, lint, styles, format, TypeScript, 527 Web unit tests, 15 package unit tests, 147 script tests, Rust format, 38 simulated-host Rust tests, 8 simulated-host browser tests, tokens, Markdown links, ownership registries, exclusions, and public-release checks.                          |

## Maintainer confirmation request

Please confirm or reject the following packet; duplicate test execution is not
required:

1. accept F1 as a new high-severity Browser Client Web-shell conclusion;
2. accept, revise, or reject the five-destination Activity-grouped prototype as
   the direction to carry into a future bounded implementation slice;
3. accept F2 as a medium accessibility conclusion that does not require a
   visual prototype;
4. accept the deduplication and rejected / non-applicable classifications;
5. accept the explicit Desktop WebView and physical-mobile direct-evidence
   limits.

No follow-up implementation Issue will be published and this research PR will
not be merged until the maintainer explicitly confirms the packet.

## Project references

- [`DESIGN.md`](../../DESIGN.md)
- [Accepted #356 interface Skill suite audit](interface-skill-suite-audit-2026-08-04.md)
- [`component-patterns.md`](../design/component-patterns.md)
- [`mobile-navigation-and-layout.md`](../design/mobile-navigation-and-layout.md)
- [`tailwind-variants.md`](../architecture/tailwind-variants.md)
- [`cross-platform-product-authority.md`](../architecture/cross-platform-product-authority.md)
