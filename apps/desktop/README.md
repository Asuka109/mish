# Mish desktop shell

This package is the thin Tauri 2 shell for the shared `@mish/web` product UI.
Development uses the explicit Vite origin at `http://127.0.0.1:4173`; production
builds embed `apps/web/dist` in the desktop binary and do not request frontend
assets, fonts, or code at runtime.

Run from the repository root:

```sh
pnpm desktop:dev
pnpm desktop:build
pnpm desktop:bundle:macos
```

The shell starts the existing Rust desktop bridge in-process on an ephemeral IPv4
loopback port. It creates a fresh 256-bit authentication token for each desktop
process and returns the endpoint and token only through the `runtime_bootstrap`
command allowed to the `main` WebView. The token is sent in the first JSON-RPC
message, never in a URL, and neither the shell nor the Web client logs or
persists it. A standalone Vite browser remains visibly fixture-backed. The
status-bar `Open Browser Client` command serves the embedded bundle from the
same bridge origin and opens it with a fresh one-time nonce in the URL fragment.
The page exchanges that nonce once for the process-only bootstrap, immediately
removes the fragment, and keeps the actual RPC token in memory only. A scoped
HttpOnly, SameSite session cookie lets that browser tab reacquire an in-memory
bootstrap after refresh without exposing the RPC token to browser storage.

The same bootstrap includes a validated settings snapshot loaded from private
application data before the Web UI renders. Settings updates travel through the
authenticated loopback RPC as bounded appearance, language, or startup DTOs.
No ordinary settings method accepts a path, command, endpoint, credential, or
raw configuration object. The durable contract is documented in
[`../../docs/architecture/settings-contracts.md`](../../docs/architecture/settings-contracts.md).

On macOS, the native title bar uses the overlay style with its title hidden.
The WebView therefore reaches the top of the window while the operating system
continues to own the traffic-light controls, window shadow, resizing, and
fullscreen behavior. The sidebar reserves the native control area, and the
sidebar header plus non-interactive workspace toolbar areas remain draggable.
Drag handling is attached to those existing surfaces rather than an overlay:
buttons, links, fields, and menu targets keep their ordinary pointer behavior,
while primary-button drags from surrounding blank space move the native window.
The complete top sidebar header, including its outer padding around the native
controls and brand, is a native deep drag region. The workspace toolbar uses
event delegation because it also contains interactive controls.

The macOS window also installs Tauri's Sidebar effect, which maps to an AppKit
`NSVisualEffectView` using the semantic Sidebar material and follows the active
window state. The bootstrap exposes only a boolean capability to the WebView.
When available, the window base and sidebar pixels are transparent so the native
compositor material can show through; the inset workspace remains an opaque
design-token surface. Browser and unsupported desktop builds retain the
deterministic `surface-soft` background. Reduce Transparency replaces the
transparent WebView regions with the same solid fallback. Native appearance is
synchronized with the light, dark, or system application preference.

Reproducible visual checks are documented in
[`../../docs/quality/native-sidebar-validation.md`](../../docs/quality/native-sidebar-validation.md).

The main window restores its last valid size, on-screen position, and maximized
state. Visibility is deliberately excluded from persisted window state: a
manual launch or Dock reopen always reveals the existing window, while a quiet
login launch still follows its explicit startup preference. The default native
application menu supplies standard edit, close, minimize, fullscreen, hide,
and quit commands; Mish adds Settings (Command-,) and Find (Command-F) entries
that route into the existing WebView.

Tauri's bundled-asset resolver returns `index.html` for an unknown asset path,
so direct loads of `/status`, `/routes`, and the other React Router paths work in
the packaged WebView. Vite provides the equivalent fallback during development.
The desktop bridge uses the same resolver for its browser client: exact assets
are served directly, unknown non-asset `GET`/`HEAD` paths fall back to
`index.html`, and missing filenames with extensions return `404`.

The Tauri composition starts in an explicit safe stopped state and does not
automatically select or restore a private profile. Authenticated activation
reloads a repository-validated artifact and uses the transactional pinned-core
manager. Development requires an explicit `MISH_MIHOMO_BIN`; production resolves
only a packaged pinned resource. Missing binaries remain visibly unavailable,
and neither mode downloads at runtime.

On macOS, the shell composes a real System Proxy adapter through the shared
runtime. System Proxy defaults off and can be enabled only when a configured
core is confirmed healthy. Mish journals the minimum prior network-service
state privately, applies only HTTP, HTTPS, and SOCKS settings, confirms the OS
result, and restores exact Mish-owned state on shutdown or restart audit. PAC,
automatic discovery, and authenticated settings are never overwritten. TUN,
production helper integration, and release distribution remain separate
platform slices. Apple Silicon test bundles, signing modes, notarization
secrets, and the exact production helper gates are documented in
[`../../docs/operations/macos-packaging.md`](../../docs/operations/macos-packaging.md).

Launch at login uses Tauri's macOS LaunchAgent integration with a fixed login
startup argument. The preference is persisted only after registration is
re-observed. Login launches can either show the main window or remain in the
background; manual launches always show the window. The default remains launch
at login off.

The macOS shell also installs a native status-bar menu backed directly by the
same runtime host, capture reconciler, and profile activation coordinator as the
authenticated Web UI. It exposes current profile state, System Proxy commands
and recovery, routing mode when supported, a Routes entry, Core restart/recovery,
an explicit browser-client launcher, and quit. TUN remains explicitly
unavailable. The menu never lists nodes, service URLs, RPC endpoints, paths, or
credentials.

Closing the main window defaults to hiding the existing window while the bridge,
Core supervision, capture reconciliation, and status menu continue. Settings can
change this to quit, which runs ordered shutdown and conservative restoration of
confirmed Mish-owned System Proxy state. This close behavior is independent from
login launch behavior. See
[`../../docs/architecture/native-status-bar-lifecycle.md`](../../docs/architecture/native-status-bar-lifecycle.md).

The Apple Silicon test bundle embeds the repository `LICENSE` and
`THIRD_PARTY_NOTICES.md` beside its other resources. The packaging verifier
requires exact copies and checks the pinned Mihomo attribution before accepting
the bundle.
