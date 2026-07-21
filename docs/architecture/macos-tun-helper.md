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

## Development service

Development uses the same runtime architecture as production: one privileged
service owns the Mihomo process, and that process creates the Darwin `utun`
interface and applies routes. The Tauri process remains unprivileged. The only
difference is how the service is installed and trusted.

Run the explicit developer command from a trusted checkout:

```sh
pnpm macos:tun:install
pnpm desktop:dev
```

The install command builds the helper, asks for administrator authorization,
and installs a root-owned LaunchDaemon, helper, and pinned Mihomo v1.19.29 copy.
The development app invokes this same bounded installer from the first-TUN
guide and Settings lifecycle actions. Authorization uses the macOS administrator
dialog; Mish never accepts or reads the credential. Cancellation remains a
typed permission failure and TUN stays off.
Each install derives a SHA-256 installation identity from the helper binary,
the pinned Core, and the generated LaunchDaemon configuration. The first-TUN
guide records that identity rather than a permanent completion flag, so an
artifact or service configuration change naturally requires the guide again
after reinstalling while identical reinstalls do not repeat it.
The service exposes a mode-0600 Unix socket owned by the installing user. Mish
reobserves the service after an in-app lifecycle operation before advertising
TUN support; an app restart is not required. `pnpm macos:tun:status` inspects
the LaunchDaemon, and `pnpm macos:tun:uninstall` stops it and moves its installed
files to the system Trash.

Repeated installs overwrite the three fixed system targets and one fixed,
private runtime receipt. They do not create per-install temporary directories,
backup copies, or versioned system files. Uninstall also removes the bounded
per-user service socket and runtime receipt; shared system directories are
never removed.

Core activation candidates are separately bounded by runtime ownership. Startup
removes only UUID-named stale candidates after orphan recovery, failed staging
removes its own candidate, successful replacement removes the stopped prior
candidate, and clean shutdown removes the final candidate. Unknown files and
directories under the runtime root are never swept as garbage.

Settings exposes a clean reinstall action even for a healthy helper. It is
available only while the managed Core is inactive, then stops the LaunchDaemon,
overwrites the fixed helper, Core, property-list, and receipt targets, starts the
service, and reobserves its version, installation identity, and health. This
operation keeps no historical system copies.

Development trust is deliberately local and explicit: the service accepts only
the configured user, the exact root-owned Core path, private candidate files
under Mish's runtime root, the pinned version, and bounded launch tokens. It
does not make an ad-hoc app bundle production-capable. Ad-hoc packages still
report the production helper as `unpackaged`.

Production packaging reserves exactly two privileged artifacts:

- `Contents/Resources/mish-tun-helper`, a production-only executable with the
  signing identifier `com.asuka109.mish.tun-helper`; and
- `Contents/Library/LaunchDaemons/com.asuka109.mish.tun-helper.plist`, whose
  `BundleProgram` is the exact bundle-relative executable path and whose sole
  Mach service is `com.asuka109.mish.tun-helper`.

These files are included only when the package command receives a Developer ID
identity with an explicit ten-character team identifier. Ad-hoc packages and
source development omit both files. The production executable contains no
development installer, Unix-socket listener, path trust, or per-user receipt
behavior.

Production availability requires all of the following:

- a Developer ID signed and notarized app and helper with the expected team and
  signing identifiers;
- an embedded LaunchDaemon property list and executable using `SMAppService`;
- mutual XPC code-signing requirements for the app and helper;
- confirmation of registered version, helper health, and disabled TUN state.

The reserved signing identifiers are `com.asuka109.mish` for the application
and `com.asuka109.mish.tun-helper` for the helper. Adding credentials to CI does
not change helper availability: the platform adapter must independently verify
the embedded LaunchDaemon, exact helper version, mutual code-signing identity,
team identity, registration status, XPC health, and disabled TUN observation
before production availability may be reported.

The credential-free production adapter implements that complete negative gate
but not the signed XPC command transport. The system observer checks the exact
Developer ID requirements and read-only `SMAppService.status`; an enabled
registration without an exact-version protocol response, healthy XPC probe,
and fresh disabled TUN observation remains recovery-required. It never falls
back to the development service. Registration, administrator approval,
production XPC activation, signing, notarization, and live TUN acceptance remain
outside this slice.

## Closed helper protocol

The production transport-neutral lifecycle contract exposes only:

- observed availability, installed and expected versions, health, lifecycle
  phase, and last typed failure;
- explicit `install`, `repair`, and `remove` lifecycle operations;
- `health`, `enable-tun`, and `disable-tun` wire commands.

Messages are capped at 16 KiB, reject unknown fields, and require protocol
version 3. Protocol version 3 carries observation schema version 1: a timestamp
plus closed `core`, `interface`, `routes`, and `dns` component states. Each
component is only `absent`, `confirmed`, `foreign`, `partial`, or `unknown`.
Observations older than ten seconds, from another schema version, or more than
one second in the future are stale. Production XPC additionally requires an
exact signed peer identifier and team identifier. It accepts no shell command,
interface name, route, DNS address, or arbitrary argument and opens no LAN
listener.

The development Unix-socket protocol adds a narrowly validated Core host
contract: `start`, `observe`, `owns-listener`, `stop`, and `stop-all`. `start`
accepts only the preinstalled root-owned Mihomo executable and a private
generated candidate at
`runtime/candidates/<UUID>/{home,config.yaml}`. The helper reads the generated
TUN flag, verifies the exact pinned Core version, and owns the complete child
process lifetime. Paths outside that shape, symlinks, loose permissions,
foreign ownership, oversized files, malformed tokens, and unknown messages are
rejected.

The development service takes a pre-launch `utun` baseline, then uses the
public macOS `libproc` descriptor APIs to enumerate kernel-control sockets held
by the exact, unreaped child PID it started. A socket named
`com.apple.net.utun_control` provides the kernel unit that maps directly to its
`utunN` interface. The service brackets the system snapshot with two descriptor
scans and attributes an interface only when the same child-owned kernel socket
is present before and after that snapshot. It then fingerprints the interface
by name and assigned addresses. A sole new interface with no matching child
descriptor is foreign, multiple child-owned interfaces are partial, and an
unavailable, changing, or malformed correlation is unknown. A changed
fingerprint, ownership transfer, or replacement is never retargeted. These
states cannot confirm enabled.

Fixed, bounded `/sbin/ifconfig`, `/usr/sbin/netstat -rn`, and
`/usr/sbin/scutil --dns` observations then confirm the correlated interface and
the managed Darwin IPv4 route partition (plus the IPv6 partition when the
interface has a non-link-local IPv6 address). DNS is confirmed from the fixed
`any:53` policy only when every observed port-53 system nameserver is either
scoped directly to the owned interface or its longest-prefix route uses that
interface. Non-port-53 resolvers do not prove or disprove this packet-path
effect. A missing route remains partial, a mixture of captured and bypassing
nameservers is partial, and nameservers whose more specific routes use another
interface leave DNS absent. This observes Mihomo's actual Darwin DNS hijack
path without changing system DNS settings. Each version or system-observation
step is capped at five seconds and command output is capped at 64 KiB. Client
deadlines cover the complete server budget: one observation step for read-only
requests, three steps plus process settling for start, and graceful stop,
bounded forced stop, and final observation for stop. A response margin keeps a
completed bounded operation from being reported unavailable while the service
continues changing state. Parsers cap interfaces, routes, resolvers,
nameservers, names, addresses, process descriptors, and child-owned interfaces.
Configuration `tun.enable` is used only to decide whether to begin ownership
tracking and is never returned as observed runtime truth.

An untracked `utun` carrying an IPv4 address is foreign rather than absent.
This conservative rule prevents a helper restart, orphaned Core, or another
TUN product from being mistaken for clean state and prevents Mish from claiming
that interface during a later launch.

Development startup classifies that foreign baseline as read-only and does not
send `stop-all`. Mish continues with its ordinary unprivileged Core while TUN
policy generation remains unavailable with the typed foreign observation. A
known Mish Core or non-foreign residual state is eligible for bounded cleanup;
an unconfirmed cleanup similarly degrades only TUN and privileged Core
operations instead of aborting the desktop bridge.

Enabled requires a fresh observation with all four components confirmed.
Disabled requires fresh absence of every Mish-owned interface, route, and DNS
effect; a non-TUN managed Core does not count as a TUN Core. Missing effects,
residual cleanup effects, an exited Core with residual effects, foreign
interfaces, parser failures, and stale observations remain non-applied typed
state.

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
mode, regenerates the active profile with the new `tun.enable` value, restarts
the service-owned Core, confirms the requested mode from the privileged network
observation, and restores the prior confirmed Core, capture, and OS state on
failure. RPC and the native status-bar menu call this same transaction. Neither
mode may be reported active from desired state alone.
