# Design QA History

## macOS title-bar integration

Status: passed and retained only as a change record.

The verified change removed the redundant native title strip, retained the
system-owned traffic-light controls, extended the workspace to the top inset,
and made the sidebar header and non-interactive toolbar regions draggable
without intercepting controls. Browser rendering remained compatible.

Temporary screenshots used during the review were intentionally not committed.
Current visual rules live in [`DESIGN.md`](DESIGN.md); reproducible native-window
checks live in
[`docs/quality/native-sidebar-validation.md`](docs/quality/native-sidebar-validation.md).

## Startup failure recovery

- Source visual truth: `/Users/asuka/.codex/visualizations/2026/07/21/019f8326-c498-72b2-9710-81d27538f56f/mish-startup-failure-reference.png`
- Implementation screenshot: `/Users/asuka/.codex/visualizations/2026/07/21/019f8326-c498-72b2-9710-81d27538f56f/mish-startup-failure.png`
- Full-view comparison: `/Users/asuka/.codex/visualizations/2026/07/21/019f8326-c498-72b2-9710-81d27538f56f/mish-startup-failure-comparison.png`
- Focused comparison: `/Users/asuka/.codex/visualizations/2026/07/21/019f8326-c498-72b2-9710-81d27538f56f/mish-startup-failure-focused-comparison.png`
- Viewport: 1600 × 1050 CSS pixels, device pixel ratio 2
- State: Chinese light appearance, failed Core startup, System Proxy selected but not running, notification center open

### Findings

No actionable P0, P1, or P2 differences remain in the annotated surfaces.

- The aggregate proxy control returns to the inactive `启动代理` state and is enabled for retry.
- The specific failure copy states that startup failed and Mish returned to idle.
- The generic `操作失败。` entry is absent when the capture failure already has a typed runtime explanation.
- Genuine System Proxy drift and non-Core capture failures retain their existing recovery state.

The full-view reference contains empty runtime data while the browser harness uses the repository's realistic fixture data. This difference is outside the three annotated changes and does not alter their layout, typography, or behavior.

### Required Fidelity Surfaces

- Fonts and typography: Existing system-font sizes, weights, line heights, and truncation behavior are unchanged.
- Spacing and layout rhythm: Existing sidebar, toolbar, Status sections, notification popover, radii, and separators are unchanged.
- Colors and visual tokens: Existing neutral, error, and selected-state tokens are unchanged.
- Image quality and asset fidelity: Existing Mish brand assets and Phosphor icons remain unchanged; no substitute assets were introduced.
- Copy and content: The Core-start failure now uses the approved idle-state explanation, and the duplicate generic notification is removed.

### Interaction And Runtime Evidence

- Browser DOM: one enabled `启动代理` button with `data-status="inactive"`.
- Browser DOM: one specific startup-failure notification and zero `操作失败。` entries.
- Primary interaction: notification center opened successfully and displayed the specific failure.
- Console errors: none.
- Automated regression: all 223 Web tests passed, including the new retry and deduplication case.
- TypeScript and generated i18n contracts passed.

### Comparison History

- Initial source finding: failed Core startup left the aggregate control in a disabled attention state and displayed both a typed capture failure and a generic command failure.
- Fix: classify `core-unhealthy` startup failure as inactive and retryable, reactivate the selected profile before retrying from a runtime error, and suppress the generic capture failure when a typed System Proxy or TUN failure already explains it.
- Post-fix evidence: the focused comparison and browser DOM checks show the idle control and one specific notification.

### Implementation Checklist

- [x] Return failed Core startup to inactive, retryable control state.
- [x] Retry through selected-profile activation before applying capture.
- [x] Keep typed System Proxy failure feedback.
- [x] Remove the duplicate generic capture failure.
- [x] Preserve genuine drift and permission recovery states.

final result: passed

## Settings simplification and packaged versions

### Evidence

- Source visual truth: the eight annotated Settings captures supplied for this review, especially `/var/folders/5z/wjdqjxyn66n_69rwycgmdz1c0000gn/T/codex-clipboard-f9355fd3-5cb1-4c40-b279-3fd8a1120d99.png` through `/var/folders/5z/wjdqjxyn66n_69rwycgmdz1c0000gn/T/codex-clipboard-473c91d7-7d27-4531-bcc0-c51a28dbde04.png`.
- In-app Browser implementation captures: `/tmp/mish-settings-zh-light-wide.png`, `/tmp/mish-settings-en-dark-narrow-bottom.png`, and `/tmp/mish-settings-zh-light-narrow-bottom.png`.
- Focused comparison: `/tmp/mish-settings-version-comparison.png` combines the annotated version-information source with the rendered narrow Settings region.
- Viewports: wide 1280 × 720 and 1900 × 900 CSS pixels; narrow 390 × 844 CSS pixels; device scale factor 1.
- State: the local demo fixture intentionally reports native Settings capabilities as unavailable. This verifies the browser fixture remains truthful while English/Chinese copy, light/dark appearance, grouping, responsive layout, and disabled controls render.

### Full-view and focused comparison

The rendered Settings page removes the annotated HTTP/SOCKS5 badges, reduced-motion row, privacy-and-access section, and expert-configuration row. It keeps the automatic proxy preference independently visible in Capture and startup. The focused version comparison confirms that the rendered Advanced and support row replaces the previous sensitive-data description and single hard-coded version with two compact version badges plus a disabled, labelled update action.

The source annotation and rendered capture use different viewport widths because the focused source is a wide, annotated crop while the implementation capture validates the required narrow-width behavior. Their content region, light Chinese state, and version-row intent are normalized for comparison; browser verification separately covered wide Chinese light, wide English dark, narrow English dark, and narrow Chinese light states.

### Findings and comparison history

1. Initial annotated findings: redundant protocol badges and availability words, excessive close-window copy, a non-configurable motion row, duplicate privacy/expert presentation, ambiguous DNS copy, and hard-coded single-version presentation.
2. Fixes: removed the indicated rows and badges; made address-family badges iconically concise but retained localized screen-reader/title semantics; shortened the requested copy; changed visible capability copy to Coming soon / 即将支持; added build-sourced Mish and pinned Mihomo badges; added an explicitly unavailable update button.
3. Post-fix evidence: the in-app Browser captures show no horizontal overflow at 390 CSS pixels, no text collision in the version control row, and correct disabled-state affordance. The focused comparison shows no remaining P0, P1, or P2 mismatch in the annotated Advanced and support surface.

### Required fidelity surfaces

- Fonts and typography: existing system font tokens, hierarchy, and compact metadata treatment are retained. The shortened copy reduces wrapping without changing typographic scale.
- Spacing and layout rhythm: removed rows collapse their section spacing cleanly; narrow captures keep controls beneath or beside their labels without overlap. The version badges and disabled button wrap within the row rather than overflow.
- Colors and visual tokens: existing success/outline badge tokens communicate IP availability; disabled and Coming soon treatments retain existing neutral contrast in light and dark themes.
- Image quality and asset fidelity: no image or brand asset changed; existing Mish asset and icon library usage remains intact.
- Copy and content: English and Chinese supplied wording is present for close behavior, network/DNS descriptions, Coming soon, and update availability. Browser fixture wording remains truthful about unavailable native controls.
- Accessibility and interaction: IPv4/IPv6 badges retain localized availability in `aria-label`, `title`, and screen-reader text; the disabled update button references its Coming soon explanation. The automatic proxy preference remains disabled in the browser fixture rather than claiming native availability.

### Verification

- In-app Browser: Settings rendered in English/Chinese, light/dark, and wide/narrow states; 390-pixel checks reported `scrollWidth === clientWidth`.
- Focused browser test: 12 passed, including Chinese narrow layout, address badge semantics/width, and disabled update control.
- Web unit tests: 264 passed.
- Rust settings tests: 26 passed, including packaged app/pinned Core version source.
- Desktop bridge protocol tests: 22 passed.
- Typecheck, generated i18n check, lint, formatting, design/token/doc checks, desktop production Web build, Rust formatting, and `git diff --check` passed.

final result: passed

## Onboarding welcome

## Evidence

- Source visual truth: `/var/folders/5z/wjdqjxyn66n_69rwycgmdz1c0000gn/T/codex-clipboard-43febbd7-9b2c-46c7-a35c-65f29c4ffa1f.png`
- Cover implementation screenshot: `/tmp/mish-onboarding-cover-implementation.png`
- Teaching-step implementation screenshot: `/tmp/mish-onboarding-step-implementation.png`
- Routing-step implementation screenshot: `/tmp/mish-onboarding-routing-implementation.png`
- Stable profile-step implementation screenshot: `/tmp/mish-onboarding-profile-stable-implementation.png`
- Vertically centered profile-step implementation screenshot: `/tmp/mish-onboarding-profile-centered-implementation.png`
- Combined comparison: `/tmp/mish-onboarding-cover-comparison.png`
- Viewport: 1280 × 720 for implementation captures. The annotated source is 1920 × 1250; the combined comparison normalizes both to a common component-review canvas.
- State: Simplified Chinese, light theme, welcome cover, profile teaching step, and routing teaching step open.

## Full-view Comparison

The revised cover uses the requested full-bleed treatment: the image reaches the dialog's top, left, and right edges and is clipped by the dialog radius. The cover has no progress indicator. The divider below the introductory description is removed. Background composition, typography hierarchy, actions, and dialog proportions remain consistent with Mish's existing desktop UI.

## Focused Comparison

The teaching-step captures verify behavior that is not directly visible in the annotated cover reference: three compact progress segments appear centered at the top, with no visible step-count text. Main step headings have no adjacent icon. Profile and capture concepts are stacked vertically with bare 24-pixel icons. Each icon and its title-description block share the exact vertical center of their 104-pixel row. The routing step replaces the three mode cards with two concise guidance paragraphs and gives the policy-group explanation the strongest content treatment. A separate crop was unnecessary because the progress indicator, heading focus treatment, educational content, and footer actions are legible in the full captures.

## Required Fidelity Surfaces

- Fonts and typography: Existing Mish type tokens and hierarchy are preserved; headings and supporting copy remain readable at the target desktop size.
- Spacing and layout rhythm: The cover image is full bleed, the title-to-body transition has no divider, teaching-step progress is isolated at the top without adding visible labels, concept rows stack vertically, and the policy-group explanation has a distinct full-width surface. All four states retain a 640 × 600 dialog at x=320, y=60, with the footer at y=597 and the primary action at x=811, y=611.5 in the 1280 × 720 viewport.
- Colors and visual tokens: Existing canvas, hairline, brand, muted-text, focus, and overlay tokens are unchanged.
- Image quality and asset fidelity: The selected local WebP cover remains sharp at the rendered size, uses the intended central focal point, and is not stretched.
- Icons: Profile and capture concept icons have a transparent background, zero border width, and no containing badge treatment.
- Copy and content: The routing step now recommends Rule mode for ordinary use, describes Global mode as a temporary fallback with a domestic-traffic latency trade-off, and explains how policy groups connect rules to selectable nodes.

## Interaction And Runtime Evidence

- Clicking the onboarding backdrop left the welcome dialog open.
- Escape, the close button, and the explicit dismiss action remain available.
- No console warnings or errors occurred while traversing the final flow.
- Dialog, footer, and primary-action geometry remained identical across the cover, profile, capture, and routing states.
- Computed row geometry confirmed each icon and text block center exactly matches its containing concept-row center.

## Comparison History

1. Earlier implementation findings: the cover was inset, a divider separated the header from the body, and a four-step indicator with visible step-count text appeared on the cover.
2. Fixes: made the cover full bleed, removed the header divider, hid progress on the cover, and changed the teaching flow to three top-aligned indicator segments with no visible count.
3. Post-fix evidence: `/tmp/mish-onboarding-cover-comparison.png` and `/tmp/mish-onboarding-step-implementation.png` show no remaining P0, P1, or P2 mismatch against the clarified annotation.
4. Later findings: backdrop clicks could dismiss a long flow, step-title icons weakened the hierarchy, and the routing page overemphasized three mode cards while underexplaining policy groups.
5. Fixes: disabled pointer dismissal only for the onboarding dialog, removed main step-title icons, simplified the routing guidance, and expanded the policy-group explanation with a concrete example.
6. Post-fix evidence: `/tmp/mish-onboarding-routing-implementation.png`, the live backdrop interaction, and the clean browser console show no remaining P0, P1, or P2 issue from the later feedback.
7. Final layout findings: the dialog and primary action moved between steps, two concept cards were arranged side by side, and concept icons used tinted square containers.
8. Fixes: established a fixed 640 × 600 flex frame with an independently scrollable body and fixed footer, gave all primary actions a 132-pixel width, stacked profile and capture concepts, and removed icon backgrounds and borders.
9. Post-fix evidence: `/tmp/mish-onboarding-profile-stable-implementation.png`, computed style inspection, and geometry measurements across all four states show no remaining P0, P1, or P2 issue from the final layout feedback.
10. Alignment finding: stacked concept-row content remained top-aligned within each row.
11. Fix: vertically centered the bare icon and title-description block as one row unit; `/tmp/mish-onboarding-profile-centered-implementation.png` and matching computed centers show no remaining P0, P1, or P2 alignment issue.

## Findings

No actionable P0, P1, or P2 findings remain.

## Follow-up Polish

No P3 follow-up is required for the requested annotation changes.

final result: passed

## Automatic proxy launch lifecycle synchronization

### Evidence

- Source intent: the annotated Settings capture showing the enabled `启动应用自动代理` preference and the lower-left `启动代理` control.
- Runtime contract: automatic startup is issued after native status observers are installed and publishes through the existing `ProfileActivationCoordinator` snapshot.
- Automated evidence: `mihomo_activation` verifies that stopping a Core and then resuming uses the last successful Profile rather than a later failed attempt; Web coverage verifies that a native-originated pending System Proxy transition renders the sidebar control busy and disabled.

### Findings

The persisted preference now has an execution path on the next full application launch. It does not mutate the running process when changed. On launch, the shared coordinator first enters `pending`, then either reaches a healthy Core and applies standard System Proxy capture, or exposes a terminal failure while leaving the runtime safely stopped. Legacy installations with no runtime resume record use the newest valid stored Profile as their one-time fallback. The sidebar derives loading from the same activation and capture snapshots that the existing native status surface subscribes to; it has no local-only startup state.

### Verification

- Rust activation integration: 24 passed, including restart after an intervening failed activation.
- Desktop shell compilation: passed.
- Web unit: 265 passed, including the native-originated pending sidebar state.
- Typecheck, lint, i18n generation, formatting, design/token/docs checks, production desktop Web build, Rust format, and `git diff --check`: passed.

final result: passed

## Unified policy-group and node browser

Status: passed.

### Visual comparison

- Compared the compact Status summary and focused picker against reference 1 at a 1928 × 1142 viewport.
- Compared the multi-group Routes workspace against reference 2 using the same rendered state and a side-by-side combined image.
- Preserved Mish typography, spacing, surfaces, theme behavior, and desktop chrome instead of copying incidental source pixels.
- Verified light/opaque Status and picker, light Routes, and dark/material Routes.

### Responsive and interaction checks

- Verified Status and picker at 800 × 600.
- Verified dedicated Routes group views at 320 × 700 and 390 × 700 without horizontal overflow.
- Verified multiple desktop groups can remain expanded and retain their independent controls.
- Verified compact rows keep effective 44 px targets and retain latency, current state, and counts.
- Verified picker search, direct selection, keyboard Escape clearing/close behavior, and focus restoration.

### Annotation follow-up: single-level picker

- Compared the annotated 971 × 689 dark Chinese picker state with the updated implementation at the same viewport, theme, locale, and open-dialog state.
- Removed the trailing browse disclosure, nested navigation stack, breadcrumb, and back action from the picker. Policy-group children now remain direct selectable or explicitly read-only rows in the current group.
- Kept hierarchy and multi-group exploration in Routes, where the extra navigation context is visible and expected.
- The updated dialog keeps the existing row density, latency, selection, protocol/group-type, search, sort, test, and read-only treatments without leaving a dead trailing column.
- The in-app Browser accessibility snapshot contains no nested browse action or current-path control, and the focused unit/browser coverage confirms Escape closes after clearing search and restores focus to the Status summary trigger.

### Annotation follow-up: stopped-Core command semantics

- Source visual truth: the two Browser Comment captures supplied in the current review at a 971 × 689 viewport, showing the configured fallback explanation and the repeated `只读` labels on otherwise selectable rows. The rendered attachments are 1228 × 920 pixels and were normalized against the stated CSS viewport.
- Implementation screenshots: `.scratch/design-qa/picker-readonly-semantics-followup.png` and `.scratch/design-qa/picker-automatic-badge-followup.png`, each 971 × 689 pixels at device scale factor 1 and captured from the in-app Browser in the same dark Chinese picker composition.
- State normalization: the source shows the stopped-Core configured catalog. The in-app Browser demo capture confirms the resulting visual hierarchy and intrinsic read-only labels; exact stopped-Core disabled-button semantics are covered by the browser-rendered component tree and focused unit assertions because the isolated demo runtime does not expose the desktop configured catalog.
- Full-view comparison: the fallback explanation is gone and the toolbar moves directly below the dialog header. Search, sort, delay testing, row density, latency, current selection, and dialog bounds remain unchanged.
- Focused comparison: a separate crop was unnecessary because the removed explanation and the row-end status labels are legible in the full 971 × 689 capture.
- Semantic result: selectable node and selector-group rows keep their accessible selection buttons but become disabled when Core commands are unavailable. They do not display `只读`. Intrinsically automatic `url-test`, `fallback`, and `load-balance` groups show an `自动选择` badge beside the group name instead of a right-aligned `只读` status. Other intrinsically non-selectable group types retain their explicit read-only state.
- Disabled composition: command unavailability dims static automatic rows and disabled selection buttons consistently, without turning search, sort, or Routes disclosure navigation into unavailable controls.
- Interaction evidence: disabled selections do not invoke commands; search, sort, and nested Routes browsing remain available, while delay-test and other write controls stay disabled.
- Required fidelity surfaces: existing typography, spacing rhythm, dark tokens, iconography, and bilingual copy remain unchanged apart from the requested deletion. No raster or brand assets changed.
- Comparison history: the first source exposed two P1 semantic conflicts—global command unavailability reused entity-level read-only labeling, and a redundant fallback explanation occupied a large dialog region. Both were removed. A second annotated pass found that static automatic groups did not inherit the stopped-Core dimming and that their `只读` status described implementation constraints rather than behavior. The second fix added disabled-row styling and moved the behavior to an `自动选择` badge beside the label. Post-fix visual evidence and stopped-Core tests show no remaining P0, P1, or P2 issue from these annotations.

### Annotation follow-up: modal sort popup stacking

- Source visual truth: `/var/folders/5z/wjdqjxyn66n_69rwycgmdz1c0000gn/T/codex-clipboard-79b3c252-0dcd-49ee-bc4a-5bb511fc3c37.png`, a 334 × 92 crop of the open picker state where activating the sort control produced no visible menu.
- Implementation screenshot: `.scratch/design-qa/picker-sort-open-implementation.png`, captured by the browser regression at an 800 × 600 CSS viewport with device scale factor 1 while the sort popup was open.
- Combined comparison: `.scratch/design-qa/picker-sort-overlay-comparison.png`, which places the supplied control crop and the complete rendered picker state on one 1600 × 600 canvas. The source uses the user's dark localized runtime while the deterministic browser fixture uses light English data; the comparison is limited to popup visibility and anchoring rather than unrelated theme or content differences.
- Finding: the Select portal was mounted outside the dialog as intended, but its positioner had an automatic stacking level below the dialog content at `z-index: 71`. The popup existed and accepted semantic queries while remaining visually occluded, a P1 interaction failure.
- Fix: the shared Select positioner now uses `z-index: 72`, directly above dialogs and below the existing tooltip layer. The popup remains aligned to the trigger and retains the existing Mish surface, border, shadow, typography, spacing, and option states.
- Post-fix evidence: the combined comparison shows all three sort options visibly anchored below the trigger without clipping or layout shift. A real-browser regression opens the modal Select, verifies the Latency option is visible, and asserts that the positioner is above the dialog before closing it with Escape.
- Comparison history: the first browser run reproduced the failure with an automatic/`NaN` computed stacking value against dialog level 71. After the shared-layer fix, all 41 browser tests passed and the desktop production bundle emitted `z-index: 72`.

### Content and state checks

- Verified English and Chinese localization, Unicode labels, long-label containment, configured fallback, reconnecting/stale behavior, empty and no-match states, delay states, and explicit non-color status labels.
- Verified the 160-node fixture, 8,192-child model fixture, 100-row batches, full-data search, and stable ordering during an active delay test.

### Evidence

Generated comparison images are stored locally under `.scratch/design-qa/` and are intentionally excluded from source control.

final result: passed
