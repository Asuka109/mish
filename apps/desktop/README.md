# Mish desktop shell

This package is the thin Tauri 2 shell for the shared `@mish/web` product UI.
Development uses the explicit Vite origin at `http://127.0.0.1:4173`; production
builds embed `apps/web/dist` in the desktop binary and do not request frontend
assets, fonts, or code at runtime.

Run from the repository root:

```sh
pnpm desktop:dev
pnpm desktop:build
```

The shell starts the existing Rust desktop bridge in-process on an ephemeral IPv4
loopback port. It creates a fresh 256-bit authentication token for each desktop
process and returns the endpoint and token only through the `runtime_bootstrap`
command allowed to the `main` WebView. The token is sent in the first JSON-RPC
message, never in a URL, and neither the shell nor the Web client logs or
persists it. The browser build does not call this command and remains visibly
fixture-backed.

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

Tauri's bundled-asset resolver returns `index.html` for an unknown asset path,
so direct loads of `/status`, `/routes`, and the other React Router paths work in
the packaged WebView. Vite provides the equivalent fallback during development.
Any future local HTTP asset host must preserve that same rule for unknown
non-asset `GET`/`HEAD` paths while returning ordinary `404` responses for
missing files with extensions.

The current desktop bridge reports a real but deliberately sparse RPC snapshot and does
not automatically start Mihomo. Controller reconciliation, System Proxy, TUN,
status-bar behavior, native material, packaging icons, signing, and notarization
remain separate platform slices.
