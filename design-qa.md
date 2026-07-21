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
