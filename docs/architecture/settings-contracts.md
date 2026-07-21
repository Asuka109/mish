# Settings Application Contracts

## Ownership

Settings is the durable configuration home for application preferences. It is
organized into the six outcome sections defined by PRD 04. It does not copy the
Status dashboard or create a second live network-state model.

`crates/settings` owns the transport-neutral preference model, persistence
boundary, platform-startup reconciliation, and settings snapshot. The desktop
bridge maps a closed set of authenticated RPC methods to that service. The Web
client renders the snapshot and continues to use the existing Status client for
System Proxy and TUN desired, observed, drift, failure, and recovery state.

Ordinary settings RPC accepts only these bounded commands:

- set one of `system`, `light`, or `dark` appearance;
- set one of `opaque` or `material` as the window-surface preference;
- set one of `en` or `zh` interface language;
- set a startup DTO containing `launchAtLogin` and exactly one
  `show-window` or `background` login-launch behavior; or
- set one of `hide-to-status-bar` or `quit` as the main-window close behavior.

Protocol version 18 also accepts one closed onboarding welcome transition:
`prompt`, `open`, `dismiss`, or `complete`. These transitions update only the
private settings record. They do not invoke Core, capture, a network observer,
a TUN helper, or any operating-system adapter.

It also exposes empty-parameter, user-triggered `installTunHelper`,
`repairTunHelper`, and `removeTunHelper` operations. Their snapshot reports
availability, installed and expected versions, health, lifecycle phase, and the
last typed failure. Each operation reobserves the helper before returning. The
closed privileged contract is defined in
[`macos-tun-helper.md`](macos-tun-helper.md).

`settings.refreshNetworkDns` is also an empty-parameter, read-only action. It
returns a bounded current/stale/unknown/failed observation and never accepts an
interface, route, DNS value, executable, path, or shell string. Its source,
lifecycle authority, parsing, and privacy rules are defined in
[`network-dns-observation.md`](network-dns-observation.md).

It accepts no file path, executable, shell command, endpoint, credential, raw
configuration object, or arbitrary preference JSON.

## Persistence

The Tauri shell stores `settings.json` below its private application-data root.
The file has a numeric schema version, rejects unknown fields, and is bounded to
32 KiB before parsing. Writes use a mode-0600 temporary file, flush file data,
atomically rename it over the destination, and flush the parent directory.

Missing storage uses safe defaults: system appearance, English, launch at login
off, native material as the desired window surface, show the window for any
future login launch, and hide the main window to the status bar on close. It
also creates and immediately persists exactly one version-2 welcome invitation
with a stable creation time. The desktop frontend records `promptedAt` when it
first presents the proactive welcome message. Opening records a separate first
open time. Dismissal records another time but retains the invitation. Completion
records its own time and suppresses the invitation across restart and future
schema upgrades.

Version 0 appearance/locale data and version 1, 2, or 3 settings migrate into
the current schema with one unprompted invitation, so existing installations
receive the same opt-in welcome after upgrading. Versions 4 and 5 carried the
earlier minimal welcome. They migrate to one unprompted version-2 invitation so
the expanded profile, capture, and routing tour is shown once even when the old
welcome was completed. Invalid, unsupported, or oversized storage is replaced
atomically with safe defaults and reported once through `storageRecovered`;
recovery does not reissue an invitation or change system startup or network
state.

The browser fixture uses local storage only as an appearance, window-surface,
and language fallback. It reports startup, native material, privacy
confirmations, and TUN as unavailable and cannot return native-operation
success. A stored material preference therefore resolves to an opaque browser
surface without being rewritten. The Settings UI omits the window-surface row
entirely whenever `nativeSidebarMaterial` is not `supported`; opaque-only Web,
mobile, and desktop platforms do not expose an inapplicable preference.

The desktop shell and authenticated desktop browser client surface the durable
invitation through their shared notification center. The installed mobile shell
is explicitly excluded from this version: it creates no invitation and mounts
neither the desktop notification center nor the welcome dialog. A future mobile
onboarding flow requires its own platform recipe rather than inheriting this
desktop modal.

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

The stored window-surface preference records user intent independently from
platform capability. `opaque` always paints a deterministic surface. `material`
requests native Sidebar material, while unsupported platforms and Reduce
Transparency resolve it to an opaque effective surface with an explicit fallback
reason. That fallback never rewrites the stored preference, so material returns
when the constraint is removed. There is no `automatic` window-surface value;
future product-default or preset policy belongs above this preference.

On supported macOS builds, settings changes apply or clear the native window
effect through a narrow platform adapter before the new preference is confirmed.
The Web appearance module independently resolves the matching DOM surface from
the confirmed preference, capability, and accessibility media query. Native
material owns blur; Mish may tune a bounded tint opacity but exposes no numeric
cross-platform blur promise.

Language selection changes only localized Mish copy. Profile, group, node, and
service labels remain opaque user-authored Unicode strings and are never passed
through translation functions.

## Window lifecycle

`windowCloseBehavior` is independent from login registration and login-launch
window behavior. macOS supports `hide-to-status-bar` and `quit`. The default
hides the existing window while the process-owned bridge, runtime supervision,
capture reconciliation, and native menu continue. Quit leaves the Tauri event
loop and therefore runs the existing ordered bridge shutdown and conservative
System Proxy restoration path. Browser and unsupported-platform adapters expose
this capability as unavailable.

The full native ownership and menu contract is documented in
[`native-status-bar-lifecycle.md`](native-status-bar-lifecycle.md).

## Privacy and capability truthfulness

The RPC settings snapshot confirms the properties enforced by the desktop
server composition: IPv4 loopback binding, authentication before ordinary RPC,
and exact origin validation. It never contains the authentication token. LAN
control is unavailable and has no switch.

Capability values come from the desktop composition, not the user agent or Web
feature detection. The macOS composition advertises status-bar and window
lifecycle support; browser and unsupported desktop compositions do not. TUN is
supported only when the signed helper is observed healthy; the current
development build reports its unsigned or unpackaged boundary. macOS Network
and DNS observation is supported as a read-only, non-persistent snapshot;
browsers and non-macOS compositions report it unavailable. Network and DNS
configuration, signed updates, and expert configuration remain non-interactive
until their separate mutation and rollback contracts exist. Local backup and
restore are supported only by the desktop composition through the native file
boundary documented in
[`local-backup-restore.md`](local-backup-restore.md); ordinary browsers report
the capability as unavailable.

Full DNS servers, search domains, network-service names, and interface
identifiers stay only in the authenticated local Settings response. They are
excluded from Events, logs, error text, persistence, and support bundles.
