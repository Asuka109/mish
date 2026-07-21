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

## Findings

No actionable P0, P1, or P2 differences remain in the annotated surfaces.

- The aggregate proxy control returns to the inactive `启动代理` state and is enabled for retry.
- The specific failure copy states that startup failed and Mish returned to idle.
- The generic `操作失败。` entry is absent when the capture failure already has a typed runtime explanation.
- Genuine System Proxy drift and non-Core capture failures retain their existing recovery state.

The full-view reference contains empty runtime data while the browser harness uses the repository's realistic fixture data. This difference is outside the three annotated changes and does not alter their layout, typography, or behavior.

## Required Fidelity Surfaces

- Fonts and typography: Existing system-font sizes, weights, line heights, and truncation behavior are unchanged.
- Spacing and layout rhythm: Existing sidebar, toolbar, Status sections, notification popover, radii, and separators are unchanged.
- Colors and visual tokens: Existing neutral, error, and selected-state tokens are unchanged.
- Image quality and asset fidelity: Existing Mish brand assets and Phosphor icons remain unchanged; no substitute assets were introduced.
- Copy and content: The Core-start failure now uses the approved idle-state explanation, and the duplicate generic notification is removed.

## Interaction And Runtime Evidence

- Browser DOM: one enabled `启动代理` button with `data-status="inactive"`.
- Browser DOM: one specific startup-failure notification and zero `操作失败。` entries.
- Primary interaction: notification center opened successfully and displayed the specific failure.
- Console errors: none.
- Automated regression: all 223 Web tests passed, including the new retry and deduplication case.
- TypeScript and generated i18n contracts passed.

## Comparison History

- Initial source finding: failed Core startup left the aggregate control in a disabled attention state and displayed both a typed capture failure and a generic command failure.
- Fix: classify `core-unhealthy` startup failure as inactive and retryable, reactivate the selected profile before retrying from a runtime error, and suppress the generic capture failure when a typed System Proxy or TUN failure already explains it.
- Post-fix evidence: the focused comparison and browser DOM checks show the idle control and one specific notification.

## Implementation Checklist

- [x] Return failed Core startup to inactive, retryable control state.
- [x] Retry through selected-profile activation before applying capture.
- [x] Keep typed System Proxy failure feedback.
- [x] Remove the duplicate generic capture failure.
- [x] Preserve genuine drift and permission recovery states.

final result: passed
