# Mihomo Web Client

Cross-platform Mihomo client for macOS, Windows, Linux, Android, and iOS, with a shared React and TypeScript product layer.

## Status

The project is in architecture and feasibility planning. No application scaffold or dependency has been selected beyond the provisional decisions recorded in the development plan.

## Current direction

- React, TypeScript, and Vite for the shared interface and product logic.
- Tauri 2 for the desktop shell and as the first mobile-shell candidate.
- A Mihomo sidecar with a minimal privileged helper on desktop.
- Native Kotlin `VpnService` integration on Android.
- Native Swift `NEPacketTunnelProvider` integration on iOS.
- A native mobile WebView-shell fallback if Tauri's iOS app-extension integration does not pass the feasibility gate.

## Documents

- [Development plan](.claude/plans/development-plan.md)
- `docs/architecture/` — architecture decisions and interface specifications.
- `docs/research/` — upstream repository and platform research.

## Next milestone

Complete the one-week feasibility gate described in the development plan before scaffolding the production application.

