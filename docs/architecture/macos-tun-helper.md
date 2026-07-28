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

The ordinary developer service remains the Stage 1, TUN-disabled Core host.
Run it from a trusted checkout:

```sh
pnpm macos:tun:install
pnpm desktop:dev
```

The install command builds the helper, asks for administrator authorization,
and installs a root-owned LaunchDaemon, helper, and pinned Mihomo v1.19.29 copy.
Before it can ask for authorization, the installer resolves the required stable
Cargo through Rustup. It checks, in order: an explicitly supplied absolute
`MISH_TUN_RUSTUP` path (for trusted repository/test fixtures), an absolute
`CARGO_HOME/bin/rustup`, the default `~/.cargo/bin/rustup`, Apple Silicon
Homebrew (`/opt/homebrew/bin/rustup`), Intel Homebrew (`/usr/local/bin/rustup`),
then absolute directories in `PATH`. The selected Rustup must return one
executable absolute Cargo path for `rustup which cargo --toolchain stable`.
The build inherits only `HOME`, `PATH`, `CARGO_HOME`, `RUSTUP_HOME`, and
`TMPDIR`; `MISH_TUN_RUSTUP` is discovery-only and is never forwarded. Missing
Rustup, invalid candidates, an absent stable Cargo, and a failed Cargo build
produce separate typed preparation results. This remains a non-privileged
prerequisite: it neither downloads the pinned Core nor installs a service or
changes network state. Live administrator-operated acceptance remains #95.
The development app invokes this same bounded installer from the first-TUN
guide and Settings lifecycle actions. Authorization uses the macOS administrator
dialog; Mish never accepts or reads the credential. Cancellation remains a
typed permission failure and TUN stays off.
Each install derives a SHA-256 installation identity from the helper binary,
the pinned Core, and the generated LaunchDaemon configuration. The first-TUN
guide records that identity rather than a permanent completion flag, so an
artifact or service configuration change naturally requires the guide again
after reinstalling while identical reinstalls do not repeat it.
Before administrator authorization, the installer also generates or reuses one
P-256 client key at
`runtime/tun-client-key.json`. The file is owned by the installing user, has
mode `0600`, and is never copied into the privileged service. The staged
enrollment candidate contains only the algorithm, public SPKI key, SHA-256 key
identifier, installing UID, and helper installation identity. Administrator
authorization commits one root-owned mode-`0600` record at
`/Library/Application Support/com.asuka109.mish/tun-helper-dev/enrollment.json`.
The service refuses to start when that record is missing, malformed, owned
incorrectly, or bound to another helper installation identity.

This plaintext private key is an explicitly weak internal-testing boundary.
It prevents an unrelated same-user process that cannot read the file from
controlling the helper, but it does not defend against malware or any process
already able to read the installing user's private application data. It is not
application identity and does not make an ad-hoc build production-trusted.

The service exposes a mode-0600 Unix socket owned by the installing user. Mish
reobserves the service after an in-app lifecycle operation before advertising
TUN support; an app restart is not required. `pnpm macos:tun:status` inspects
the LaunchDaemon, and `pnpm macos:tun:uninstall` stops it and removes the
installed trust record and both active or pending private-key records while
moving the non-secret installed service files to the system Trash.

Repeated installs overwrite the three fixed system targets and one fixed,
private runtime receipt while preserving the enrolled key and monotonic
generation. An identical reinstall is a no-op for trust. An explicitly
authorized helper update may rebind the same key and generation to the new
installation identity; simply changing the identity in the LaunchDaemon makes
startup fail closed. The installer does not create backup copies or versioned
system files. Uninstall also removes the bounded per-user service socket and
runtime receipt; shared system directories are never removed.

### Internal TUN Alpha package profile

The `internal-tun-alpha` package productizes this accepted development service
for a trusted Mac without requiring a repository checkout, Node.js, Rust,
Homebrew, compilation, or a runtime download. It is a separate service archive,
not a `Mish.app` layout and not a release-profile variant selected by signing
inputs.

The package includes only one native lifecycle controller, the feature-gated
development Helper, the exact pinned Core, a closed LaunchDaemon template, one
versioned manifest, license/notices, and fixed user-facing install, health,
status, repair, and uninstall resources. The manifest records every allowed
relative path, role, mode, size, and SHA-256 digest. Package and installed-layout
verification reject symlinks, hard links, writable paths, unexpected or
duplicate files, unbounded records, wrong versions or hashes, mutable
identities, and profile leakage.

Installation retains the accepted trust contract: the controller generates or
reuses the user-owned mode-`0600` P-256 private record, stages only its public
candidate, and the administrator-authorized transaction enrolls that candidate
into the root-owned record. The installation identity remains
SHA-256(Helper bytes || pinned Core bytes || per-user rendered LaunchDaemon
template with the installation-identity placeholder). The fixed socket, kernel
UID/PID checks, canonical path/ownership/freshness gates, closed typed commands,
single-owner lifecycle, and canonical challenge-response are unchanged.

Before requesting administrator authorization, the running controller copies
its already verified executable to a private mode-`0500` staging file and
binds its exact manifest size and SHA-256 digest into the authorization
request. The root shell copies that candidate into a new root-owned mode-`0700`
temporary directory, independently requires the expected owner, group, mode,
single link, size, and SHA-256 digest, and only then executes the root-owned
mode-`0500` copy. The privileged process verifies its own canonical staging
path and digest again before it revalidates the original closed package. A
same-UID replacement of either user-writable source therefore fails before
untrusted bytes can execute as root.

The package lifecycle adds matching root-owned and user-owned receipts bound to
the exact manifest digest, Helper/Core/plist digests, versions, installation
identity, installing UID, enrollment key identifier, and generation. Health
requires those receipts and fixed installed artifacts to match, then requires
an authenticated protocol-v3 status with no Core and a fresh disabled network
observation.

After the privileged transaction returns, install and repair allow a bounded
15-second readiness window for a cold launchd/Gatekeeper start. Only
`core-host-unavailable` is retried; artifact, receipt, enrollment, protocol,
identity, or disabled-observation failures still fail immediately and trigger
the same confirmed rollback. This prevents a healthy delayed socket from being
misclassified without weakening any trust check.

Uninstall reads and validates the root enrollment and receipt before any
`launchctl` stop or global filesystem mutation. Both records must authorize
the requesting UID and agree on installation identity, key identifier, and
generation. A partial, foreign, or unowned global layout fails closed; a clean
not-installed layout permits only the private user-state cleanup.

This package deliberately exposes no Core start, TUN enable/disable, arbitrary
path/command, or network-mutation action. Its LaunchDaemon fixes
`MISH_TUN_SERVICE_ALLOW_TUN=0`; post-install is healthy and disabled.
`alpha-ad-hoc`, `signed-direct`, Browser Client/application resources, and
future production layouts remain free of all Internal TUN Alpha artifacts and
fail closed if one appears.

The package is ad-hoc, not Developer ID signed, Apple-trusted, or notarized. It
is only for explicitly trusted internal distribution. Its file-backed
mode-`0600` private key does not protect against same-user malware. Production
still requires the independent `SMAppService`, signed XPC, same-Team,
notarization, and acceptance boundaries below.

### Installation-key authentication

Unauthenticated discovery is limited to the helper version, protocol version,
installation identity, algorithm, key identifier, and generation. It cannot
observe a Core launch token or network state and cannot mutate anything.
`status`, Core ownership checks, Core start/stop, TUN enable/disable, and every
other command use a two-message proof on the same kernel-credentialed Unix
connection:

1. The client sends the exact typed command, a UUID request identity, and a
   random 32-byte client nonce.
2. The helper returns a random 32-byte helper nonce plus its installation
   identity, current key identifier and generation, kernel-observed peer
   UID/PID, command operation, SHA-256 command digest, issue time, and expiry.
3. The client signs the canonical transcript with ECDSA P-256/SHA-256 and sends
   only the DER signature and challenge identity.
4. The helper consumes the challenge before verification, verifies the
   signature against the root-owned enrollment, and only then continues through
   every existing path, token, owner, Core identity, and observed network-state
   gate.

Canonical transcript version 1 is a domain-separated, big-endian,
length-prefixed binary encoding. In order, it binds the transcript and helper
protocol versions, helper installation identity, enrolled generation and key
identifier, helper and client nonces, peer UID/PID, operation and request
identity, exact command digest, issue time, and expiry. Challenges live for at
most five seconds. The helper accepts at most 64 outstanding challenges and
remembers 256 request identities. A replay, helper restart, malformed field,
clock rollback beyond the one-second skew, expiry, wrong key/generation,
changed command, changed UID/PID, or stale installation identity fails before
Core or network mutation.

The client-key, enrollment, and transcript formats each carry an independent
version and algorithm name. The private key and any pending replacement remain
inside user-owned mode-`0600` files. They never enter RPC, command arguments,
environment variables, logs, Events, diagnostics, support bundles, local
backups, release bundles, repository fixtures, or the privileged helper.
Public enrollment candidates and dual-signature rotation requests contain no
private material.

`pnpm macos:core-host:rotate-key` performs ordinary rotation. It stages a new
private key, signs one canonical rotation record with both current and
replacement keys, stops the service, verifies both proofs in the root-owned
helper, advances the generation exactly once, and starts the service with only
the replacement public key trusted. The pending private record remains usable
if the process stops between privileged commit and local finalization, so a
restart can finish without an overlapping trust window. The old public key is
rejected immediately after commit.

`pnpm macos:core-host:reset-key` is the lost-key recovery path. It requires a
new P-256 key and a fresh administrator authorization; no ordinary helper
command can reset trust. The stopped helper advances the generation and
atomically commits the replacement before relaunch. Tart equivalents require
the exact `:tart` commands. Both operations run only after the existing
watchdog/LaunchDaemon shutdown boundary has bounded Core and DNS cleanup.

A future production migration generates a new non-exportable P-256 key in
Keychain or Secure Enclave where supported, then uses the same dual-proof
rotation shape. It does not import the plaintext development key into Secure
Enclave. After the new generation commits, Mish deletes the plaintext key.
Production still independently requires `SMAppService`, Developer ID
same-Team audit-token validation, signing, notarization, and signed XPC.

### Disposable Tart TUN acceptance

The complete development TUN path requires a second, exact boundary on both
sides of the service:

```sh
pnpm macos:tun:install:tart
pnpm desktop:dev:tart-tun
```

These commands are for a disposable Tart guest only and must never be run on
the host Mac. The installer records the Tart opt-in in the installation
identity, and the desktop launcher accepts it only in a Tauri development
build. Omitting either side keeps Virtual Interface unavailable. Demo,
ordinary source development, alpha-ad-hoc, signed-direct, and production
layouts are unchanged and fail-closed.

Inside this boundary, the service accepts only Mish's fixed private managed
runtime layout and the existing pinned Core. The generated policy fixes
`fake-ip-range` to `198.18.0.1/16` and the upstream resolver to `1.1.1.1`.
When activation is explicitly enabled, the service resolves the current
default route to exactly one enabled Wi-Fi or Ethernet
`SCNetworkService`. It rejects virtual, unsupported, absent, or ambiguous
topologies without requiring unrelated unsupported virtual services to expose a
BSD interface name. The ownership snapshot binds the service's stable
SystemConfiguration identifier, display name, BSD interface, interface kind,
addresses, exact prior DNS servers, and the bounded stable default,
local-subnet, link-local, and multicast routes on that physical interface,
plus the scoped `.local` mDNS resolver. Transient host/neighbor routes are
excluded from the ownership snapshot. Only that service's DNS is set to
`198.18.0.1`.
Unrelated services, resolvers, routes, VPNs, and System Proxy settings are
never mutated.

The exact prior DNS list is restored on disable, normal owner exit, forced
owner exit, helper exit, or Core exit. Restoration first re-resolves the stable
service identity and reads its current DNS. It writes only when the identity
still matches and the current value is either Mish's managed value or the
already-restored prior value. A replacement service or foreign DNS value is
never overwritten. The final identity check, DNS comparison, protocol update,
commit, and apply run inside one non-waiting exclusive `SCPreferences` lock
after synchronizing the locked session. A busy lock fails without mutation, so
another conforming SystemConfiguration writer cannot replace the compared value
before Mish's write. A write whose result cannot be confirmed is rolled back
immediately; if exact rollback cannot be confirmed, the transaction remains
tracked as recovery-required. The independent watchdog carries only a
versioned, bounded copy of the same service identity, prior DNS snapshot, and
root-generated transaction UUID. A watchdog restores or clears the recovery
record only when that complete transaction identity still matches. The record
has an atomic `prepared`/`applied` phase: while prepared, prior DNS cannot be
treated as completed recovery because the in-flight apply may still commit;
managed DNS remains recoverable if the process dies between its write and the
applied marker. The watchdog then removes its submitted launchd job after its
bounded attempt. A stale watchdog therefore cannot restore or consume a later
transaction even when the service and prior DNS are otherwise identical. If
Helper reap or explicit stop cannot restore DNS because the non-waiting
preferences lock is temporarily busy, it stops Core but leaves the independent
watchdog registered to finish its bounded recovery loop and retains the exact
pending transaction in memory. Later status or start handling retries that
transaction. If the watchdog already restored the exact prior DNS and removed
its record, the Helper converges to off only after freshly confirming that
exact prior DNS; managed, foreign, or unknown DNS without the record and any
present mismatched record still fail closed without mutation. The same
exact-prior confirmation makes simultaneous watchdog and Helper restoration
idempotent when one wins the compare-and-set race.
Before the DNS write, the service also atomically commits that same bounded
state in prepared phase to a root-owned mode-`0600` recovery record beside the
installation enrollment, then atomically marks it applied after the DNS write.
Exact restoration and record removal are one transaction. Immediately after
confirming its root identity, Helper restart or cold boot first consumes that
record before validating the Core binary, runtime root, or enrollment needed
for new requests. A missing or damaged request prerequisite therefore cannot
strand managed DNS. An invalid record, service-identity mismatch, foreign DNS
value, or failed restoration remains a typed non-disabled recovery state.
Uninstall performs the same restoration and refuses to discard an unresolved
record. An uninstall retry after the private recovery directory has already
been removed treats that directory as already-absent, while an existing unsafe
directory or record still fails closed.
No arbitrary network service, DNS value, path, or command crosses the
privileged protocol.

This DNS transaction exists because the fixed Mihomo `any:53` listener and
Darwin route policy must be observed on the actual guest packet path. A helper
acknowledgement or desired configuration is insufficient. Applied requires a
fresh service observation that correlates the root-owned child with Mish's
`utun` and confirms the managed route partition and DNS effect. The DNS write
itself is ordered after a fresh, bracketed child-descriptor correlation and a
complete exact route fingerprint; an incomplete or changing packet path cannot
reach that mutation.

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
the configured user and peer PID, a valid enrolled-key proof, the exact
root-owned Core path, private candidate files under Mish's runtime root, the
pinned version, and bounded launch tokens. It does not make an ad-hoc app bundle
production-capable. Ad-hoc packages still report the production helper as
`unpackaged`.

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

The development Unix-socket protocol adds an installation-key-authenticated,
narrowly validated Core host contract: `status`, `start`, `observe`,
`owns-listener`, `enable`, `disable`, `stop`, and `stop-all`. Only the bounded
version/enrollment discovery described above is unsigned. `start`
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
interface has a non-link-local IPv6 address). The first complete route
observation is retained as an exact destination, gateway, flags, and interface
fingerprint. Later missing, duplicate, or changed-fingerprint routes are
partial or foreign and cannot confirm Applied.

DNS is confirmed from the fixed `any:53` policy only when every observed
port-53 system nameserver is either scoped directly to the owned interface or
its longest-prefix route uses that interface. Non-port-53 resolvers do not
prove or disprove this packet-path effect. A missing route remains partial, a
mixture of captured and bypassing nameservers is partial, and nameservers whose
more specific routes use another interface leave DNS absent.

The route and resolver baseline also protects the physical packet path. The
Darwin split-default routes installed by the pinned Core are less specific than
existing link-local, local-subnet, and multicast routes. The adapter requires
the exact stable baseline routes in those classes to remain present and
requires a scoped `.local` resolver; transient host and neighbor cache routes
are deliberately not retained. macOS may expose either explicit port-5353
multicast fields or its implicit `.local` resolver shape; the latter is
accepted only while a more-specific physical route still reaches
`224.0.0.251` or `ff02::fb`.
Consequently Bonjour and LAN traffic continue to use the more-specific
physical route without a broad hard-coded subnet exception. Any loss or drift
of that evidence prevents Applied.

Each version or system-observation step is capped at five seconds and command
output is capped at 64 KiB. Client deadlines cover the complete server budget:
system observation plus network-service lookup for read-only requests; the
precondition observation, apply-time lookup, and complete post-apply status for
enable; five steps plus process settling for start; and graceful stop, bounded
forced stop, and complete final status for stop. A response margin keeps a
completed bounded operation from being reported unavailable while the service
continues changing state. Parsers cap
interfaces, routes, resolvers, nameservers, names, addresses, process
descriptors, and child-owned interfaces. Configuration `tun.enable` is used
only to decide whether to begin ownership tracking and is never returned as
observed runtime truth.

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
