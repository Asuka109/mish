# Interface Skill Suite Audit

Date: 2026-08-04

Issue: [#356](https://github.com/Asuka109/mish/issues/356)

Decision state: **maintainer acceptance required; no production rule is accepted by this document**

## Executive decision

Do not install or vendor any reviewed Skill. The current Jakub Krehel suite is a
useful review checklist, but it is not a drop-in Mish design authority. Mish
already has stronger product-specific ownership in `DESIGN.md`, Tailwind
Variants recipes, semantic tokens, Base UI behavior, localization, Rust DTOs,
and platform-boundary documents.

The selective recommendation is:

1. adapt the current accessibility, layout, writing, and UI review questions to
   Mish's existing contracts;
2. codify only the typography and color ideas that survive current product and
   standards checks;
3. reject the earlier monolithic Skill as an integration source because the
   current suite supersedes it;
4. reject the standalone OKLCH Skill as an integration source at the pinned
   revision because it has no repository license and contains guidance corrected
   by the newer suite;
5. prototype, but do not implement, two systemic candidates: touch-adaptive Web
   product controls and authoritative pending/finalizing feedback.

There is no `use unchanged` recommendation. Even the strongest upstream source
needs Mish-specific ownership, density, localization, state, and platform
constraints.

## Scope and non-goals

This audit covers the current `jakubkrehel/skills` interface suite, the earlier
`make-interfaces-feel-better` Skill and article, the standalone OKLCH Skill and
related writing, and representative Mish Desktop WebView, Browser Client, and
installed-mobile surfaces.

It does not:

- change production UI;
- install Skills, copy upstream instructions, or add dependencies;
- implement the focus-visible repair owned by [#323](https://github.com/Asuka109/mish/issues/323);
- replace or imitate Native outer-shell chrome, whose accepted ownership remains
  defined by [#343](https://github.com/Asuka109/mish/issues/343);
- convert the semantic hex token source to OKLCH;
- create implementation Issues before maintainer acceptance.

## Method and evidence limits

The source repositories were reviewed at exact commits without executing their
contents. All instruction and reference files at those revisions were read.
The Mish audit combined source inspection, existing tests, the fixture-backed
`pnpm demo`, responsive browser measurement at 1280×720 and 390×844, and current
standards sources. Demo actions modify fixture data only.

This is a representative state audit, not a claim that every route/state pair was
manually exercised. A cell marked **direct** below has a focused test or live
fixture observation. **Shared** means the state is supplied by a shared primitive
or provider and was checked at that ownership layer. **Not applicable** means the
surface cannot own that state under the accepted architecture.

## Source inventory and provenance

| Source                                                                                                                                    | Pinned revision / retrieval                            | License and provenance                                               | Maintenance signal                                                                                | Portability and overlap                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`jakubkrehel/skills`](https://github.com/jakubkrehel/skills/tree/a67333399dabbc71d7778962cb9c4fb9b86a00d0)                               | `a67333399dabbc71d7778962cb9c4fb9b86a00d0`, 2026-07-29 | MIT, copyright Jakub Krehel; reviewed from the author's repository   | Recent seven-skill split; no release tag or deterministic validation suite at the pinned revision | Markdown advice is host-portable, but install metadata favors Claude/Codex workflows. `better-interface` delegates to six domain owners and contains no independent domain rules. |
| [`make-interfaces-feel-better`](https://github.com/jakubkrehel/make-interfaces-feel-better/tree/5f3c3c26c512b3469e6dbcab8a0d73e8b575a566) | `5f3c3c26c512b3469e6dbcab8a0d73e8b575a566`, 2026-07-24 | MIT, copyright Jakub Krehel                                          | Earlier monolithic snapshot, five days older than the suite                                       | Almost entirely overlaps newer `better-ui`, `better-typography`, and `better-accessibility`; weaker domain ownership.                                                             |
| [“Details that make interfaces feel better”](https://jakub.kr/writing/details-that-make-interfaces-feel-better)                           | Retrieved 2026-08-04                                   | Author-published case-driven article; no code copied                 | Live article linked by the author                                                                 | Useful examples, not a normative or licensed instruction package. Several ideas already exist in Mish.                                                                            |
| [`oklch-skill`](https://github.com/jakubkrehel/oklch-skill/tree/fd37e17ae4991c42851a65a72dd105f16eb611e1)                                 | `fd37e17ae4991c42851a65a72dd105f16eb611e1`, 2026-07-10 | **No `LICENSE`, `NOTICE`, or `COPYING` file at the pinned revision** | Older independent repository; superseded in part by `better-colors`                               | Advice-only content is technically portable, but unlicensed copying is not acceptable and several rules are corrected by the current suite.                                       |
| [OKLCH Skill page](https://jakub.kr/skills/oklch-skill) and [“What are OKLCH colors?”](https://jakub.kr/components/oklch-colors)          | Retrieved 2026-08-04                                   | Author-published descriptions; no content copied                     | Live explanatory pages                                                                            | Helpful background, not a reason to migrate Mish's accepted token notation.                                                                                                       |
| [“Less is more”](https://jakub.kr/writing/less-is-more)                                                                                   | Retrieved 2026-08-04                                   | Author-published case-driven essay                                   | Live article                                                                                      | Supports Mish's existing motion restraint; no independent implementation rule.                                                                                                    |

No third-party code, Skill text, or article prose is vendored by this delivery.
The prototype is an original Mish-specific artifact built from first-party tokens
and behavior contracts.

## Integration matrix

Decision meanings:

- **Use unchanged**: adopt the source as-is.
- **Adapt**: retain selected review questions behind Mish ownership.
- **Codify only**: record a small surviving rule or rationale; do not integrate
  the Skill.
- **Reject**: do not use this source as an integration authority.

| Source / owner domain                              | Decision        | Mish integration boundary                                                                          | Conflicts, corrections, and overlap                                                                                              |
| -------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Current `better-interface` orchestrator            | **Adapt**       | Optional audit routing only; `DESIGN.md` remains authority                                         | It adds no independent rules and cannot supersede project contracts.                                                             |
| Current `better-accessibility`                     | **Adapt**       | Use as review prompts after Base UI semantics, current tests, and WCAG 2.2                         | Universal target-size preferences need density and input-context adaptation. Focus appearance work stays in #323.                |
| Current `better-layout`                            | **Adapt**       | Use grouping, alignment, overflow, zoom, and narrow-width questions in page reviews                | Mish already owns a 4px rhythm, compact containers, and platform-specific navigation. Do not introduce a new spacing system.     |
| Current `better-writing`                           | **Adapt**       | Use clarity and nearby-explanation questions inside existing en/zh catalogs                        | English capitalization and Rust semantic identity are project-owned. User content remains opaque Unicode.                        |
| Current `better-typography`                        | **Codify only** | Preserve numeric stability, deliberate wrapping, punctuation, and platform fonts where evidenced   | Mish already has six type roles and no-download system fonts. Do not import a second type scale or font dependency.              |
| Current `better-colors`                            | **Codify only** | Permit OKLCH for bounded palette exploration and gamut reasoning; remeasure final semantic pairs   | Preserve the accepted hex token source. WCAG 2.2 contrast remains the conformance gate; APCA may be supplementary research only. |
| Current `better-ui`                                | **Adapt**       | Use surface hierarchy, icon-context, compositor-only motion, and performance questions selectively | Reject universal scales, stagger, and decorative motion. Base UI and existing CSS own behavior; no Motion dependency.            |
| Earlier `make-interfaces-feel-better` Skill        | **Reject**      | Historical comparison only                                                                         | Superseded by the current split suite and lacks its clearer ownership/corrections.                                               |
| “Details that make interfaces feel better” article | **Codify only** | Cite individual cases only when a Mish finding has local evidence                                  | Concentric radii, tabular numbers, stable wrapping, subtle exits, and image edges are contextual—not universal laws.             |
| Standalone `oklch-skill` repository                | **Reject**      | No instruction or prose integration                                                                | Missing repository license; older claims are materially corrected by `better-colors`.                                            |
| OKLCH Skill page                                   | **Codify only** | Background link for palette exploration                                                            | Marketing/overview material is not an implementation contract.                                                                   |
| “What are OKLCH colors?” article                   | **Codify only** | Background for perceptual coordinates and gamut                                                    | CSS Color 4 is the technical authority; the article does not justify a token migration.                                          |
| “Less is more” article                             | **Codify only** | Rationale for the existing reduced-motion and restraint contract                                   | Already aligned with Mish; no new rule or dependency required.                                                                   |

### Why the standalone OKLCH source is rejected

The later `better-colors` material corrects important earlier guidance:

- preserve existing color notation unless a migration is intentionally accepted,
  rather than converting every new color automatically;
- adjust lightness first but still remeasure the actual foreground/background
  pair after chroma, hue, gamut mapping, and conversion;
- do not mechanically reverse a light palette for dark mode;
- treat APCA polarity and thresholds carefully instead of using a single blanket
  number.

The [CSS Color 4 specification](https://www.w3.org/TR/css-color-4/) supports
OKLCH as a perceptually improved color space and defines gamut mapping, but that
does not make color notation itself a contrast guarantee. Mish should keep its
semantic-token identity and validate the rendered pairs. WCAG 2.2 still requires
4.5:1 for ordinary text and 3:1 for qualifying large text under
[SC 1.4.3](https://www.w3.org/TR/WCAG22/#contrast-minimum). APCA describes an
emerging WCAG 3 direction in the [author's canonical research repository](https://github.com/Myndex/SAPC-APCA),
so it must not replace Mish's current conformance gate.

## Applicability matrix

| Recommendation or observed pattern                           | Classification                                 | Evidence and decision                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic color roles, light/dark pairs, and surface scopes   | **Existing strength**                          | `packages/design-tokens/src/tokens.css`, `SurfaceScope`, and `DESIGN.md` already provide project-owned semantics.                                                                                                                                                                                        |
| Compact platform typography with numeric stability           | **Existing strength**                          | Six first-party type roles; `tabular-nums` is already used for dynamic metrics and layout-stability tests cover Status. Keep auditing isolated misses.                                                                                                                                                   |
| Base UI dialog/menu/select/tab semantics                     | **Existing strength**                          | Shared primitives own keyboard/focus semantics; page code composes them rather than reimplementing widgets.                                                                                                                                                                                              |
| en/zh catalog ownership and opaque user content              | **Existing strength**                          | Full locale catalogs and capitalization tests; Rust DTO identity is not translated ad hoc in components.                                                                                                                                                                                                 |
| Reduced motion and compositor-only overlay transitions       | **Existing strength**                          | Global reduced-motion rules and existing opacity/transform transitions; no animation dependency needed.                                                                                                                                                                                                  |
| Browser/desktop text selection policy                        | **Non-applicable upstream advice**             | Mish intentionally disables accidental shell selection and re-enables selectable data, code, inputs, and notifications. Reject “all text selectable” as a global rule.                                                                                                                                   |
| Touch-adaptive Web product controls                          | **Systemic shared primitive gap; prototype A** | Live 390×844 Browser Client measurement: bottom navigation is 44px, while toolbar controls are 30–34px and Status segmented/capture controls are 30px. Preserve desktop density; adapt only coarse-pointer/narrow product content.                                                                       |
| Authoritative pending → finalizing/cleanup → result feedback | **Systemic recipe candidate; prototype B**     | The codebase has strong local implementations, but no single shared presentation contract for the non-cancellable cleanup phase required by high-risk actions. Candidate is a recipe/state contract, not a generic async engine.                                                                         |
| Flow-relative shared primitive geometry                      | **Systemic codify-only gap**                   | Shared dialog, menu, table, toggle-group, command, and several route recipes use physical `left/right`, `pl/pr`, and `text-left`. Shipped en/zh are both LTR, so this is not a current locale defect. Adopt logical properties opportunistically in touched code after acceptance; do not broad-rewrite. |
| Individual missing `tabular-nums` or wrap handling           | **Component-local**                            | Fix only when a specific dynamic value visibly shifts or overflows; do not add a global typography utility sweep.                                                                                                                                                                                        |
| Page-specific long URL/chain/dialog overflow                 | **Component-local, mostly strong**             | Traffic detail has wide/narrow/short viewport tests with body-only scrolling; Profiles and Events have explicit empty/loading/error layouts. Continue route-owned fixes.                                                                                                                                 |
| Explicit keyboard focus ring repair                          | **Existing Issue ownership: #323**             | Coordinate only. This audit does not change `:focus-visible`, route heading outlines, or Base UI focus styles.                                                                                                                                                                                           |
| Native outer-shell replacement with Web chrome               | **Rejected**                                   | Violates accepted #343: Native owns persistent outer chrome; React Router/WebView owns product pages and internal history. Prototype A intentionally omits Native chrome.                                                                                                                                |
| Universal 44×44 desktop controls                             | **Rejected**                                   | Conflicts with compact utility density and mouse/keyboard desktop use. WCAG 2.2 AA specifies 24×24 or sufficient spacing, while 44×44 is an enhanced target. Use input-aware adaptation, not a global density reset.                                                                                     |
| Universal spring, stagger, scale, or “delight” animation     | **Rejected**                                   | Repetition and high-frequency telemetry make it distracting and costly. Preserve restrained CSS and `prefers-reduced-motion`.                                                                                                                                                                            |
| New font, icon, motion, or color runtime dependency          | **Rejected**                                   | Existing system fonts, Lucide, Base UI, CSS, and tokens are sufficient.                                                                                                                                                                                                                                  |
| Hex-to-OKLCH token rewrite                                   | **Rejected**                                   | High churn with no evidenced user outcome; would disrupt the accepted semantic token source and visual baselines.                                                                                                                                                                                        |

The touch decision is intentionally stricter than WCAG's minimum without
misstating the standard. [WCAG 2.2 SC 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
requires at least 24×24 CSS pixels or qualifying spacing and notes that larger
targets improve touchscreen use. The proposed 44px mobile target is a Mish
product preference for coarse-pointer product controls, not a WCAG AA claim.

## Representative surface and state audit

### Coverage table

| Surface                                                                         | Empty                          | Loading                                        | Error                                                      | Disabled                                          | Pending                                     | Success                                              | Overflow                                                        | Navigation                                                          | Localization                                                          |
| ------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Desktop WebView — Status, Profiles, Traffic detail, Events**                  | Direct: Profiles `Empty`       | Direct: route and Profiles loading             | Direct: runtime/capture scenarios and Events typed failure | Direct: capability-owned capture/profile actions  | Direct: shared spinner and capture controls | Direct: command/notification DTO outcomes            | Direct: Traffic detail body-only scrolling at wide/short widths | Direct: sidebar, router focus, dialog return                        | Direct: en/zh status geometry and catalogs                            |
| **Browser Client — authentication/recovery, Status, Traffic, responsive shell** | Shared: route `Empty` patterns | Direct: startup placeholder and route suspense | Direct: authentication/recovery and provider failures      | Direct: unavailable capabilities remain explained | Direct: launch/capture/profile actions      | Direct: fixture command completion and notifications | Direct: Traffic tables/details and 390px shell                  | Live: 1280px sidebar → 390px bottom navigation                      | Live: English/Chinese and light/dark switched without structural loss |
| **Installed mobile — Home, Routes drill-down, Activity, Settings**              | Direct: route fixtures         | Shared: mobile provider/bootstrap states       | Direct: unavailable Core/VPN and route recovery copy       | Direct: unavailable platform capabilities         | Shared: Web product action primitives       | Shared: typed results and route state                | Direct: mobile page browser tests and bounded route content     | Direct: five destinations, progressive Back, deep-link preservation | Direct: shared catalogs; semantic platform data remains opaque        |
| **Native outer shell**                                                          | Not applicable                 | Native-owned startup only                      | Native-owned launch/bootstrap only                         | Native capability presentation only               | Native-owned outer-shell action only        | Native-owned outer-shell result only                 | Native-owned                                                    | Native owns persistent chrome; Web owns page/back history           | Native catalogs only; no Web imitation                                |

### State findings

**Empty and loading.** `Empty` and route suspense are already shared, compact,
and semantically simple. Profiles owns a specific empty state. Do not replace
these with decorative illustrations or additional animation.

**Error and recovery.** Typed Rust/application failures are presented near the
owning surface; Events tests preserve geometry across a load conflict, and
browser authentication distinguishes recoverable from inline errors. Preserve
semantic error identity and avoid generic rewritten messages.

**Disabled and pending.** Most disabled states reflect actual capability or
single-flight limits and expose descriptions. Existing `Button` supplies
`aria-busy`, a stable inline spinner, and optional pending copy. The systemic
candidate is specifically the cleanup/finalizing interval: early validation may
show an actionable error, but the initiating command must remain single-flight
until rollback, process recovery, or network restoration finishes.

**Success.** Typed command results and notification authority already prevent
optimistic success claims after dispatch failure. Do not add a generic green
toast layer that competes with the existing notification lease/registry.

**Overflow.** Traffic detail and responsive shell tests are strong. Shared
dialogs and menus are bounded. Continue local tests for user-provided names,
URLs, route chains, Chinese copy, 200% zoom, and narrow containers.

**Navigation.** The Browser Client correctly changes the same Web navigation
from sidebar to bottom layout. Installed mobile uses a dedicated five-tab Web
product shell today. The accepted target boundary remains one Native outer-shell
authority with one-way entry into Router destinations; Web still owns internal
product history. No prototype in this delivery depicts or replaces Native
chrome.

**Localization.** Live English/Chinese switching preserved roles and route
structure. Both current locales are LTR, so physical-direction utilities are a
future portability debt, not a current Chinese defect. Flow-relative properties
are the standards-aligned direction for future work; see
[CSS Logical Properties Level 1](https://www.w3.org/TR/css-logical-1/) and
[CSS Writing Modes Level 4](https://www.w3.org/TR/css-writing-modes-4/).

## Prototype decision packet

Run the standalone artifact:

```sh
python3 -m http.server 4174 --directory designs/issue-356-systemic-interface-candidates
```

Then open `http://127.0.0.1:4174/`.

The artifact supports light/dark, English/Chinese, desktop/mobile frames, and a
simulated reduced-motion preference.

### Candidate A — touch-adaptive Web product controls

Before: the 30–34px compact controls observed in the current 390px Browser
Client are reproduced. After: desktop remains compact, while mobile/coarse-input
product controls receive a 44px interaction box. Visual icon and type sizes do
not grow. Native outer chrome is absent by design.

Accept only if the maintainer agrees that:

- touch adaptation belongs in shared Web primitive variants/tokens;
- it applies to product content, dialogs, and menus, not Native shell chrome;
- desktop mouse/keyboard density remains unchanged;
- important multi-control rows may reflow instead of shrinking targets.

### Candidate B — authoritative finalizing feedback

Before: a generic disabled “Pending” button can appear complete as soon as an
early error is known. After: one stable action row distinguishes `Pending`,
`Finalizing`, `Error`, and `Success`; it keeps duplicate commands blocked during
cleanup and associates the reason with the action. The prototype exposes a
replayable state cycle and does not claim that a toast owns command truth.

Accept only if the maintainer agrees that:

- the recipe is limited to actions with real cleanup/rollback/recovery phases;
- the domain state machine remains authoritative;
- the shared layer owns presentation anatomy and accessibility only;
- low-cost side-effect-free validation is repeated at the actual commit boundary.

## Maintainer acceptance checklist

Please explicitly accept or reject each item:

1. the source integration matrix;
2. the applicability matrix and its #323/#343 boundaries;
3. prototype A, touch-adaptive Web product controls;
4. prototype B, authoritative pending/finalizing feedback;
5. the codify-only flow-relative-property rule.

Only accepted systemic rules may be added to `DESIGN.md` or owning architecture
documents. Only then may bounded implementation Issues be created. Rejected
items remain research history and must not create product work.

## Standards and project references

- [CSS Color Module Level 4](https://www.w3.org/TR/css-color-4/)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [WCAG 2.2 target size understanding](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [WCAG animation from interactions understanding](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions)
- [WAI-ARIA button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/)
- [CSS Logical Properties Level 1](https://www.w3.org/TR/css-logical-1/)
- [CSS Writing Modes Level 4](https://www.w3.org/TR/css-writing-modes-4/)
- [`DESIGN.md`](../../DESIGN.md)
- [`component-patterns.md`](../design/component-patterns.md)
- [`mobile-navigation-and-layout.md`](../design/mobile-navigation-and-layout.md)
- [`tailwind-variants.md`](../architecture/tailwind-variants.md)
- [`cross-platform-product-authority.md`](../architecture/cross-platform-product-authority.md)
- [`mobile-native-shell-ownership-2026-08-03.md`](mobile-native-shell-ownership-2026-08-03.md)
