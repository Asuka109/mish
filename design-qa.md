# Design QA — macOS title-bar integration

- Source visual truth: `/var/folders/5z/wjdqjxyn66n_69rwycgmdz1c0000gn/T/codex-clipboard-c118cb5f-5d30-4ad7-88f7-385579390ad4.png`
- Implementation capture: `/tmp/mish-desktop-overlay-current-front.png`
- Normalized side-by-side comparison: `/tmp/mish-titlebar-qa-comparison.png`
- Viewport: 1160 × 761 logical pixels, captured at 2× density
- State: packaged macOS desktop shell, dark appearance, Status route, local runtime connected without a configured Mihomo controller

## Findings

No actionable P0, P1, or P2 differences remain within the annotated title-bar and window-frame scope.

- The native macOS title text and separate title-bar strip are absent.
- The operating system owns the only visible traffic-light controls.
- The foreground workspace begins at the top window inset and continues to the bottom inset, preserving the 10px Arc-like spacing required by `DESIGN.md`.
- The sidebar brand and navigation remain aligned and unobstructed below the native controls.
- The workspace toolbar and sidebar header retain draggable non-interactive regions without replacing native window behavior.
- Interactive toolbar descendants keep their ordinary pointer behavior because drag routing is delegated from the existing surface rather than captured by an overlay.

## Fidelity Surfaces

- Fonts and typography: unchanged system-font stack, weights, sizes, line heights, and hierarchy; the hidden native title removes only redundant chrome.
- Spacing and layout rhythm: the 164px sidebar, 10px workspace inset, 12px workspace radius, toolbar height, and content gutters remain aligned to `DESIGN.md`.
- Colors and visual tokens: existing light/dark tokens are unchanged; native controls follow macOS active/inactive rendering rather than being color-simulated by the WebView.
- Image and asset fidelity: this scoped change contains no raster imagery or bespoke visual assets; existing Phosphor product icons are unchanged.
- Copy and content: application labels and route content are unchanged; only the redundant native title is hidden.

## Full-view Comparison Evidence

The normalized comparison shows the annotated implementation on the left and the revised packaged application on the right. The revised window removes the separate title strip, places the native controls over the sidebar surface, eliminates the second rendered set, and raises the foreground workspace to the top inset without altering the page composition.

## Focused-region Comparison Evidence

A separate crop was not needed. The full-view comparison is normalized to the same window aspect ratio and 760px height, and the complete title-bar/sidebar junction is legible at that scale. The requested change is confined to this junction and the workspace frame.

## Comparison History

1. Source finding — P1: the visible native title bar consumed a separate horizontal band and duplicated the WebView-rendered traffic lights.
2. Fix: configured the Tauri macOS title bar as a hidden-title overlay, retained native decorations, reserved the native control slot, hid the illustrative WebView controls in desktop runtime, and added safe drag regions.
3. Post-fix evidence: `/tmp/mish-desktop-overlay-current-front.png` shows one native control set, no title strip, and the workspace spanning the available window height with the intended inset.
4. Interaction finding — P1: declarative drag markers did not reliably initiate a drag in the packaged overlay window.
5. Fix: replaced drag markers with explicit native `startDragging`/`toggleMaximize` delegation on existing top surfaces, excluding interactive descendants without adding a hit-testing overlay.
6. Interaction finding — P2: the sidebar's control slot and brand row were draggable, but their shared outer padding left dead strips inside the intended top sidebar header.
7. Fix: grouped the complete sidebar header, including its outer padding, into one native deep drag surface while leaving the navigation below it outside the drag region. The mixed interactive toolbar keeps the delegated handler.
8. User verification: both the sidebar header and workspace toolbar can move the packaged window, while the controls beneath the toolbar remain interactive. An earlier automated miss was attributable to synthetic pointer placement near native window hit-test regions rather than the implementation.

## Open Questions

None for this scoped window-frame change.

## Implementation Checklist

- [x] Preserve native close, minimize, zoom/fullscreen, resize, and shadow behavior.
- [x] Remove the separate title strip and title text.
- [x] Prevent duplicated traffic-light controls in the desktop runtime.
- [x] Keep browser fixture rendering compatible.
- [x] Preserve the project design tokens and Arc-like workspace inset.
- [x] Verify the packaged application at the target viewport.

## Follow-up Polish

Native sidebar vibrancy remains a separate platform slice already identified by `DESIGN.md`; it is not required for this title-bar correction.

final result: passed
