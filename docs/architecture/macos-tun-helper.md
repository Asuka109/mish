# macOS TUN Helper Contract

This document owns the privileged boundary for Mish's macOS TUN lifecycle.
The minimum supported system for the production design is **macOS 13**.

## Platform choice

Mish uses Apple's modern Service Management model: a signed app bundles a
signed LaunchDaemon under `Contents/Library/LaunchDaemons`, declares its
executable with `BundleProgram`, and registers it through `SMAppService`.
Registration is always initiated by a visible user action. A
`requiresApproval` result remains pending until the user approves the service
in System Settings; Mish must reobserve the service and may not report an
installation as complete before that confirmation.

This follows Apple's [Service Management documentation](https://developer.apple.com/documentation/servicemanagement/),
[helper migration guidance](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos),
and [`SMAppService.Status.requiresApproval`](https://developer.apple.com/documentation/servicemanagement/smappservice/status-swift.enum/requiresapproval).
`SMJobBless` is deprecated and is not part of the production design. Supporting
macOS 12 or older would require a separately reviewed compatibility path and is
outside this contract.

Tauri capabilities continue to authorize only the local main WebView and the
authenticated loopback bridge. They do not grant root authority. The helper is
not a Tauri shell sidecar and cannot be used to bypass macOS registration or
signing. See Tauri's [capability model](https://v2.tauri.app/security/capabilities/).

## Truthful development boundary

The current Tauri configuration does not produce a signed app bundle containing
the LaunchDaemon. Desktop development therefore reports either `unsigned-app`
or `unpackaged`, with `invalid-signature` or `not-installed` health. Install,
repair, remove, and TUN enable commands fail with a typed result. This is a
testable integration preview, not a production-capable privileged helper.

Production availability requires all of the following to exist in a later
signed packaging slice:

- a Developer ID signed and notarized app and helper with the expected team and
  signing identifiers;
- an embedded LaunchDaemon property list and executable using `SMAppService`;
- mutual XPC code-signing requirements for the app and helper;
- confirmation of registered version, helper health, and disabled TUN state.

## Closed helper protocol

The transport-neutral contract exposes only:

- observed availability, installed and expected versions, health, lifecycle
  phase, and last typed failure;
- explicit `install`, `repair`, and `remove` lifecycle operations;
- `health`, `enable-tun`, and `disable-tun` wire commands.

Messages are capped at 16 KiB, reject unknown fields, require protocol version
1, and require an exact signed peer identifier and team identifier. The helper
accepts no shell command, executable, filesystem path, Mihomo configuration,
interface name, route, DNS address, or arbitrary argument. It opens no LAN
listener.

Repair and removal first disable and reobserve TUN. Every lifecycle operation
is serialized and followed by a fresh observation. Permission refusal,
registration approval, signature failure, version drift, connection failure,
or an unconfirmed result remains a typed failure.

## Managed Mihomo policy

Mihomo v1.19.29 exposes TUN fields including `file-descriptor`, `dns-hijack`,
`auto-route`, and `auto-detect-interface` in its
[pinned configuration types](https://github.com/MetaCubeX/mihomo/blob/v1.19.29/config/config.go).
Its pinned TUN listener passes those options to sing-tun in
[`listener/sing_tun/server.go`](https://github.com/MetaCubeX/mihomo/blob/v1.19.29/listener/sing_tun/server.go).
On Darwin, pinned sing-tun creates or adopts a utun descriptor and configures
the interface in
[`tun_darwin.go`](https://github.com/SagerNet/sing-tun/blob/v0.4.21/tun_darwin.go),
while route changes use the native route socket. Those operations cross the
privileged boundary and cannot be inferred from a successful Core start.

TUN defaults off. Enabling its generated runtime layer requires both a healthy,
exact-version helper snapshot and an explicit TUN selection. Mish replaces the
entire source `tun` mapping with a fixed configuration: `gvisor`, `any:53` DNS
hijack, automatic routing, automatic interface detection, and strict routing.
Source-controlled device names, descriptors, routes, and DNS parameters never
cross the helper boundary.

System Proxy and TUN transitions are serialized. A transition disables the old
mode, confirms the requested mode, and restores the prior confirmed Core,
capture, and OS state on failure. Neither mode may be reported active from
desired state alone.
