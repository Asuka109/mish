# Settings Application Contracts

## Ownership

Settings is the durable configuration home for application preferences. It is
organized into the six outcome sections defined by PRD 04. It does not copy the
Status dashboard or create a second live network-state model.

`crates/settings` owns the transport-neutral preference model, persistence
boundary, platform-startup reconciliation, and settings snapshot. The desktop
bridge maps a closed set of authenticated RPC methods to that service. The Web
client renders the snapshot and continues to use the existing Status client for
System Proxy desired, observed, drift, failure, and recovery state.

Ordinary settings RPC accepts only these bounded commands:

- set one of `system`, `light`, or `dark` appearance;
- set one of `en` or `zh` interface language;
- set a startup DTO containing `launchAtLogin` and exactly one
  `show-window` or `background` login-launch behavior.

It accepts no file path, executable, shell command, endpoint, credential, raw
configuration object, or arbitrary preference JSON.

## Persistence

The Tauri shell stores `settings.json` below its private application-data root.
The file has a numeric schema version, rejects unknown fields, and is bounded to
32 KiB before parsing. Writes use a mode-0600 temporary file, flush file data,
atomically rename it over the destination, and flush the parent directory.

Missing storage uses safe defaults: system appearance, English, launch at login
off, and show the window for any future login launch. Version 0 appearance and
locale data migrates into the current schema. Invalid, unsupported, or oversized
storage is replaced atomically with safe defaults and reported once through
`storageRecovered`; no system startup or network state is changed during
recovery.

The browser fixture uses local storage only as an appearance and language
fallback. It reports startup, native material, privacy confirmations, and TUN as
unavailable and cannot return native-operation success.

## Launch at login

The macOS shell uses the official Tauri 2 autostart plugin with its LaunchAgent
backend and a fixed `--mish-login-startup` argument. The application service
does not report a startup change as applied until it calls the native adapter
and re-observes the requested registration state. Failed or unavailable native
operations do not update persisted startup preferences.

`launchAtLogin` controls OS registration. `loginLaunchBehavior` is an exclusive
enum rather than two conflicting booleans. The behavior applies only when the
fixed login-startup argument is present: `show-window` reveals and focuses the
main window, while `background` keeps it hidden. A manual launch always reveals
the main window.

The implementation boundary was checked against the
[Tauri 2 autostart plugin](https://v2.tauri.app/plugin/autostart/) and Apple's
[`SMAppService`](https://developer.apple.com/documentation/servicemanagement/smappservice)
registration model. Mish currently uses Tauri's documented LaunchAgent backend;
it does not claim to use `SMAppService.mainApp` directly.

## Appearance and language

The desktop bootstrap includes the validated initial settings snapshot so the
WebView can choose appearance and language before rendering application UI. A
small local browser cache preserves the existing no-flash document theme while
private app data remains authoritative for desktop preferences. System
appearance continues to react to operating-system changes and synchronize the
native window theme.

Language selection changes only localized Mish copy. Profile, group, node, and
service labels remain opaque user-authored Unicode strings and are never passed
through translation functions.

## Privacy and capability truthfulness

The RPC settings snapshot confirms the properties enforced by the desktop
server composition: IPv4 loopback binding, authentication before ordinary RPC,
and exact origin validation. It never contains the authentication token. LAN
control is unavailable and has no switch.

Capability values come from the desktop composition, not the user agent or Web
feature detection. TUN is unavailable. Network and DNS configuration, signed
updates, backup and restore, and expert configuration are marked `coming-later`
and remain non-interactive summaries until their platform and recovery contracts
exist.
