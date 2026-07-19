# Native Sidebar Material Validation

## Boundary

The macOS Tauri window owns the compositor material. Its window configuration
enables transparency and installs the semantic Sidebar effect with a state that
follows whether the window is active. Tauri maps that effect to an AppKit
`NSVisualEffectView` using behind-window blending.

The desktop bootstrap returns `nativeSidebarMaterial: true` only for a macOS
shell build. The WebView uses that capability to make the sidebar and exposed
window base transparent. The inset workspace continues to paint the opaque
`canvas` token. Browser and unsupported builds never enable the transparent CSS
path. Reduce Transparency paints `surface-soft` across the transparent regions
without introducing CSS blur, a gradient, or a captured wallpaper.

The application appearance preference is synchronized to the native window:
light and dark select the matching native appearance, while system clears the
override so AppKit follows macOS changes.

## Automated checks

Run from the repository root:

```sh
pnpm --filter @mish/web test:run
pnpm --filter @mish/web typecheck
cargo test -p mish-desktop
cargo check -p mish-desktop
pnpm desktop:build
```

The Web tests cover the explicit native-material bootstrap capability, browser
fallback, strict bootstrap validation, native light/dark/system synchronization,
and browser isolation. The Tauri build validates the window-effect configuration,
macOS private transparency feature, generated permissions, and embedded Web
artifact together.

## Manual macOS matrix

Build and launch the real shell rather than relying on Vite preview:

```sh
pnpm desktop:build
./target/release/mish-desktop
```

Use non-sensitive test content behind the window, then verify:

1. The desktop or test window contributes to the sidebar material while the
   workspace remains fully opaque, including during resize and fullscreen.
2. Native traffic lights remain clickable and clear of the sidebar brand. Drag
   the blank sidebar header and workspace toolbar; confirm buttons and menus do
   not start a window drag.
3. Move focus to another application without covering Mish. The material should
   adopt the inactive-window treatment and return when Mish becomes active.
4. Select light, dark, and system appearances. Sidebar material, native controls,
   Web content, and workspace border should remain visually coherent. Change the
   macOS appearance while Mish uses system mode and confirm it updates without a
   relaunch.
5. Enable **System Settings → Accessibility → Display → Reduce transparency**.
   The sidebar and exposed window base should become the readable deterministic
   `surface-soft` fallback with no desktop sampling. Disable the setting and
   confirm native material returns.
6. Launch the ordinary browser client. Its sidebar must remain `surface-soft`
   with no transparency or CSS glass simulation.
7. During a one-minute idle observation and repeated resizing, confirm there is
   no visible material flicker, unexpected animation, or sustained high CPU use.

Do not commit screenshots from this check. If temporary evidence is needed,
capture only the Mish window over prepared non-sensitive content and move the
file to Trash immediately after inspection.
