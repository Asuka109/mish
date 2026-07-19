# PRD 04: Settings and Native Integration

## Metadata

- Status: Draft for product review
- Version: 0.1
- Date: 2026-07-18
- Destination: Settings, native shell, and platform adapters

## Product bet

For a user who needs the client to behave reliably as a long-running system
utility, organize platform and advanced controls by outcome, show only supported
capabilities, and make every privileged network change reversible. Success means
daily operation rarely requires Settings, while setup and recovery remain clear
when the platform requires them.

## Settings information architecture

| Section | Owns | Examples |
| --- | --- | --- |
| Capture and startup | Application lifecycle and OS capture integration | System Proxy behavior, TUN setup, launch at login, quiet launch |
| Network and DNS | Core network behavior with clear risk explanations | IPv6, DNS policy, ports, interface choice, LAN access |
| Appearance and interaction | Non-network preferences | Theme, language, reduced motion, sidebar behavior, default destination, shortcuts |
| Updates and data | Versioning and local persistence | App/core updates, GeoData, backup/restore, retention |
| Privacy and access | Trust boundaries | Diagnostics consent, loopback access, optional LAN control, secrets |
| Advanced and support | Rare operations | Directories, current configuration, developer tools, reset, version information |

Settings shall not repeat live traffic, active-node claims, or large health
cards. Contextual setup and recovery remain near the affected control, with
Settings as the durable configuration home.

## Requirements

| ID | Priority | Requirement | Acceptance criteria |
| --- | --- | --- | --- |
| SET-F-001 | P0 | Settings shall be grouped by the outcome-oriented sections above. | Given the desktop Settings destination, when a user scans it, then each setting has one owning section and network-changing controls are separated from appearance preferences. |
| SET-F-002 | P0 | The UI shall derive availability from platform capabilities. | Given TUN, launch-at-login, tray, or native material is unsupported, then the corresponding setting is omitted or disabled with a truthful explanation. |
| SET-F-003 | P0 | Network-changing settings shall show pending, applied, failed, and observed-drift states. | Given an OS operation fails after the desired value changes, then the UI restores or marks the prior confirmed state and offers recovery. |
| SET-F-004 | P0 | System Proxy settings shall be reconciled against observed OS state. | Given another app changes the proxy, then the client detects drift and does not continue to display a false applied state. |
| SET-F-005 | P1 | TUN setup shall use a narrow privileged helper and explicit install/repair/remove lifecycle. | The UI explains why privilege is needed, reports helper version/health, and can return to a safe no-TUN state after failed setup. |
| SET-F-006 | P0 | Application startup behavior shall distinguish launch at login, show window, and quiet/background launch. | Each option describes its effect; conflicting combinations are prevented or resolved explicitly. |
| SET-F-007 | P0 | Appearance shall support light, dark, and system modes plus reduced-motion behavior. | Theme changes preserve contrast and focus; system mode follows OS changes; reduced motion disables non-essential animation. |
| SET-F-007A | P1 | Window surface shall be selectable independently from color appearance. | On platforms that support native material, users can choose opaque or native material and Reduce Transparency falls back without overwriting the stored preference; opaque-only platforms omit the setting entirely. |
| SET-F-008 | P0 | Language changes shall not modify user-authored labels or configuration content. | Given the UI language changes, then app copy changes but profile, group, node, and service labels remain byte/Unicode equivalent. |
| SET-F-009 | P0 | The local web and RPC endpoint shall remain loopback-only by default. | Fresh installs expose no LAN listener and require authenticated, origin-validated local access. |
| SET-F-010 | P2 | Any LAN or external-control feature shall be a separately designed, off-by-default security feature. | Enabling it requires explicit scope, authentication, displayed bind address, risk explanation, and an easy disable/revoke path. |
| SET-F-011 | P1 | App and core updates shall be signed, attributable, and failure-recoverable. | Before applying an update, version and source are shown; signature/checksum is verified; failed update retains or restores a runnable prior version. |
| SET-F-012 | P1 | GeoData and other runtime resources shall expose source, version, last success, and failure without becoming hidden network calls. | Automatic update policy is visible and can be disabled; failed updates retain the previous valid resource. |
| SET-F-013 | P1 | Backup and restore shall state exactly which local data and secrets are included. | A backup preview lists categories; restore validates compatibility and can roll back if activation fails. |
| SET-F-014 | P1 | Reset actions shall be scoped and require confirmation proportional to impact. | Reset appearance, derived history, profiles, and full application data are separate actions; full reset cannot be triggered by an ambiguous generic button. |
| SET-F-015 | P1 | Global hotkeys shall map to named application commands and be conflict-aware. | Given a user records a shortcut for window, routing mode, System Proxy, TUN, or profile reactivation, then conflicts are detected, the command scope is stated, and disabling global hotkeys removes the registrations. |
| SET-F-016 | P1 | Large expert subsystems shall use summary-first progressive disclosure. | TUN, DNS, backup, and runtime configuration show current effective state and common actions first; expert fields live in a dedicated detail surface with validation, reset scope, and unsaved-change protection. |
| SET-F-017 | P1 | External-controller configuration shall expose the complete trust boundary. | Listener address, port, secret, allowed origins/CORS policy, enabled state, and copy/revoke actions are shown together; no external listener is created by default. |
| SET-F-018 | P2 | Optional local traffic tunnels shall be modeled as explicit forwarding rules. | Each tunnel states TCP/UDP scope, local endpoint, target endpoint, optional group/child pinning, enabled state, validation, and conflict errors before activation. |
| NATIVE-F-001 | P1 | The macOS shell shall provide a status-bar menu backed by the same application state as the web UI. | Capture, profile, group selection, open window/browser, reload/restart, and quit commands reconcile across surfaces. |
| NATIVE-F-002 | P1 | Closing the main window shall follow an explicit, discoverable lifecycle preference. | Depending on preference, close hides to status bar or quits; first-use behavior is explained and can be changed. |
| NATIVE-F-003 | P1 | Sleep, wake, network switch, and core restart shall reconcile runtime and OS state. | Integration tests show stale proxy/TUN settings are detected, streams reconnect, and the user is warned when safe recovery cannot be automatic. |
| NATIVE-F-004 | P1 | Native sidebar material shall degrade to deterministic surfaces. | Reduce Transparency, unsupported shells, browser mode, inactive windows, and compositor failure retain readable opaque surfaces. |
| NATIVE-F-005 | P1 | The desktop bridge shall continue operating independently of the main window. | Given the window is hidden or closed according to preference, then core supervision, capture reconciliation, scheduled refresh, and status-menu commands continue without a live WebView. |
| SET-NF-001 | P0 | Secrets shall use platform-appropriate protected storage and redaction. | Ordinary UI, logs, crash evidence, clipboard actions, and exports do not reveal stored credentials by default. |
| SET-NF-002 | P1 | Unsaved expert-setting changes shall never leak into live runtime state. | Given the user changes fields in an expert detail surface and cancels, then desired settings and effective runtime configuration remain unchanged. |

## Native status-bar menu contract

The menu is a compact command surface, not a miniature copy of every page. Its
stable hierarchy is:

1. Open Status / Open browser client.
2. Aggregate Start or Stop with current health wording.
3. Routing mode.
4. System Proxy and TUN capture states.
5. Active profile.
6. Visible policy groups, each expanding to its children.
7. Restart core / Open diagnostics when relevant.
8. Quit.

Rates and active applications may be shown as non-interactive context only when
they remain cheap and stable. They must disappear before the menu becomes a
dashboard or exposes sensitive activity unexpectedly.

The installed Clash Verge Rev tray menu could not be reached through the current
Computer Use runtime. This contract therefore remains a required native-shell
validation surface rather than a fully observed competitor behavior.

## Platform rollout constraints

- **macOS P0/P1:** Tauri window and status bar, System Proxy adapter, signed
  helper for TUN, launch-at-login, native material, notarized update path.
- **Windows/Linux P2:** same product contract with capability-specific service,
  tray, proxy, DNS, TUN, and packaging adapters.
- **Android/iOS P2:** native VPN lifecycle remains outside the WebView process.
  The shared UI consumes capabilities and application state; it does not own the
  packet tunnel. Android owns permission, TUN, foreground lifetime, and the
  embedded Core in `VpnService`. iOS owns Packet Tunnel settings, provider
  messaging, and the embedded Core in its App Extension. Android is the first
  runnable device target while iOS shell, bridge, extension, and framework work
  proceeds in parallel. See
  [`../../architecture/mobile-runtime-integration.md`](../../architecture/mobile-runtime-integration.md)
  and [`../../quality/mobile-validation.md`](../../quality/mobile-validation.md).

## Failure and recovery behavior

- Privileged setup never appears successful before helper health is verified.
- If the app exits unexpectedly, the next launch audits and offers to repair
  stale System Proxy or TUN state.
- Update failure preserves a runnable app/core pair and records an actionable
  local event.
- Backup restore never activates an unvalidated profile set.
- Developer tools and raw configuration access are clearly advanced and do not
  bypass product validation silently.
- Third-party Web UI URL templates, CSS injection, and shell startup scripts are
  not P0 requirements. If introduced later, each receives an explicit trust and
  code-execution boundary rather than being treated as an appearance preference.

## Metrics and validation

- A clean-account user can install or decline TUN without ambiguity about the
  permission and can return to a safe no-TUN state.
- Forced termination, sleep/wake, network switching, and core crash fixtures
  leave no undetected stale System Proxy state.
- Status-menu commands pass parity tests against the main window.
- Signed offline builds contain no unexpected CDN or runtime UI assets.
- Appearance passes light/dark, active/inactive, Reduce Transparency, reduced
  motion, 1x/2x scale, and keyboard checks.

## Dependencies

- Platform-capability DTO and adapters.
- Authenticated desktop bridge and same-origin web/RPC serving.
- Tauri shell, status menu, window lifecycle, and native material.
- Signed helper/update strategy and protected secret storage.
- Event and diagnostic contracts from PRD 03.

## Open questions

1. Should closing the macOS window hide to the status bar by default, or should
   the first run ask once?
2. Which settings are safe to synchronize across devices, and which must remain
   machine-local?
3. Is LAN control needed at all, or can it remain an explicit non-goal until a
   separate threat model and PRD exist?
4. What update mechanism and rollback storage budget are acceptable for app,
   Mihomo core, helper, and GeoData as independently versioned artifacts?
