# macOS Tart development TUN acceptance

This document records the redacted real-macOS evidence for the explicit
development/Tart TUN boundary delivered for Issue #95. The run used a uniquely
named disposable clone of the stopped `mish-85-stage1-acceptance` image. The
base image was not modified, and the host Mac received no helper installation
or network-state change.

The clone contained only the repository checkout, the repository-pinned Mihomo
v1.19.29 artifact, and `docs/quality/fixtures/core-host-stage1.yaml` copied to
the application profile directory as `fictional-tart.yaml`. No personal
profile, subscription, node, credential, token, or unrelated network data was
captured.

## Boundary and installation

- Ordinary `desktop:dev`, demo, alpha-ad-hoc, signed-direct, and production
  layouts remained unavailable for Virtual Interface.
- The service and application both required their exact Tart acceptance
  options. Omitting either option failed closed.
- `pnpm macos:tun:prepare:tart` completed without authorization or network
  mutation. `pnpm macos:tun:install:tart` then used the explicit terminal
  administrator flow inside the clone.
- The LaunchDaemon property list was `root:wheel` mode `0644`; the helper and
  pinned Core were `root:wheel` mode `0555`; the per-user socket was
  `admin:daemon` mode `0600`.
- Status was installed, health was successful, the helper reported protocol
  version 3 and a 64-character installation identity, and no Core was running
  before activation.

## Activation and packet-path proof

The repository RPC harness observed `off`, `pending`, then `applied`. Applied
was published only after the privileged service confirmed all four components:

```json
{
  "core": "confirmed",
  "dns": "confirmed",
  "interface": "confirmed",
  "routes": "confirmed"
}
```

The active Core was the fixed root-owned pinned binary. Exactly one new
Core-owned `utun` appeared over the guest baseline. The complete managed
IPv4/IPv6 route partition was observed on that interface, including Darwin's
`128.0/1` spelling. The guest `Ethernet` DNS state was the fixed managed
`198.18.0.1` address. System Proxy remained disabled and byte-for-byte equal to
the captured prior state.

With System Proxy still off, a public HTTP request completed with status 200.
Mish Traffic concurrently observed the new port-80 connection. Desired state
or helper acknowledgement alone was never accepted as packet-path proof.

Disable returned the projection to `off` with Core, interface, routes, and DNS
all `absent`. The new `utun` and managed routes were gone, DNS was restored to
the exact prior automatic state, and System Proxy still matched its prior
state.

## Lifecycle and failure matrix

| Scenario                        | Real macOS observation                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal application termination  | The unprivileged app and root Core exited; DNS and routes were restored.                                                                                                                                            |
| Forced application termination  | The owner boundary stopped the Core and removed every managed network effect.                                                                                                                                       |
| Helper exit and launchd restart | An independent launchd watchdog restored DNS and stopped the Core before the helper restarted. The app projected a typed failure, never Applied.                                                                    |
| Core exit                       | The watchdog restored DNS; routes disappeared; the app projected `failed` with `core-unhealthy` and an observed-disabled network state.                                                                             |
| Ethernet off/on                 | DNS was restored and the app projected `drift` with `observation-partial`, never Applied. Forced owner cleanup then removed the remaining bounded Core/route drift.                                                 |
| Sleep/wake simulation           | The active app was suspended and continued inside the clone; the still-confirmed Core, interface, routes, and DNS remained Applied. A subsequent disable required one bounded retry and then cleaned up completely. |
| Failed activation               | The healthy service was deliberately booted out before the command. Activation returned `capability-unavailable` plus `helper-connection-failed`; no Core, interface, route, or DNS effect appeared.                |
| Cold boot recovery              | After a Tart suspend snapshot could not be resumed, a cold boot contained no app, Core, managed route, or managed DNS residue; the installed helper returned healthy and idle.                                      |

The guest also attempted `pmset sleepnow` after scheduling a relative wake.
Virtualization.framework rejected guest sleep with error `0xe00002e2`. Tart
successfully created a suspended snapshot, but the installed Tart and
Virtualization.framework combination rejected snapshot restore with
`VZErrorDomain Code=12`. The process suspend/continue simulation, lifecycle
unit fixture, network-change journey, and cold-boot audit therefore provide the
bounded sleep/recovery evidence without claiming a guest sleep notification
that the VM could not produce.

## Tests and cleanup

The final source state passed on macOS in the clone:

- all 69 repository script tests;
- all `mish-platform-macos` tests with `development-core-host`;
- the `mish-bridge` lifecycle-coordination and Mihomo-activation suites;
- the development desktop Cargo build with `development-core-host`;
- the Web suite, except for one unrelated fixture timing failure in the full
  run; its exact test passed immediately when rerun in isolation.

`pnpm macos:tun:uninstall:tart` then returned `not-installed`. The LaunchDaemon,
helper, pinned Core, private socket and state directory, installer receipt,
watchdog job, app process, and Core process were absent. Managed route count was
zero, DNS exactly matched the prior automatic state, and the complete System
Proxy snapshot matched byte-for-byte. The disposable clone was stopped and
deleted only after this evidence was retained.

## Installation-key acceptance (Issue #254)

The 2026-07-27 run used the unique disposable clone
`mish-254-installation-key-20260727` from the same stopped base image. The
host and base image remained unchanged, and the clone was deleted after the
bounded evidence below was retained.

- Preparation created one deterministic user-owned mode-`0600` P-256 private
  record. The candidate passed to the administrator flow was also mode `0600`
  but contained only the algorithm, public SPKI, key identifier, installation
  identity, and installing UID.
- Installation enrolled generation 1 in the root-owned mode-`0600` record and
  created the existing `admin:daemon` mode-`0600` private socket. A same-UID
  client with a separately generated private key was rejected for both signed
  status and disable operations. The trusted client still succeeded, while
  Core, DNS, routes, interfaces, and System Proxy remained unchanged.
- An identical reinstall preserved both key identifier and generation. A
  launchd helper restart and a complete desktop-app restart then accepted the
  same key without enrollment repair.
- The administrator-authorized rotation required signatures from the current
  and replacement keys, advanced generation from 1 to 2, atomically made the
  replacement active, and left no pending-key overlap. The retired key was
  rejected immediately while the replacement succeeded.
- The rotated key completed the real TUN journey. The RPC harness observed
  `off`, `pending`, and `applied`; Core, interface, routes, and DNS were all
  confirmed before Applied. A public HTTP request returned 200 and Mish Traffic
  observed it while System Proxy stayed disabled. Disable restored the exact
  automatic DNS state and System Proxy digest and reduced the guest from five
  `utun` interfaces to its four-interface baseline.
- A forced app-process exit stopped the app-owned Core without allowing an
  unrelated authenticated process to bypass the existing PID owner gate.
  Restarting the app retained generation 2 and the same replacement key.
- Uninstall deleted the root enrollment, active and pending private-key paths,
  and installer receipt, then removed the LaunchDaemon, helper, pinned Core,
  socket, and socket state. No Mish helper, app, or Core process remained. DNS,
  System Proxy, and the baseline `utun` count were unchanged.

The clone also passed all 76 pre-existing repository script tests, the 11
focused installer tests after the discovery-frame regression was added, all 64
`mish-platform-macos` library tests plus its integration suites with
`development-core-host`, and the matching all-target Cargo check. The
repository-wide pull-request gate was rerun on the final source state outside
the clone.

## Dynamic real-host network ownership (Issue #295)

The 2026-07-27 run used the unique disposable clone
`mish-295-real-host-20260727` from
`ghcr.io/cirruslabs/macos-tahoe-base:latest` at digest
`sha256:a8e1c8305758643f513fdccdd829c2243687c60791083dea42f73f0b7aeb435c`.
The guest ran macOS 26.5 on Apple Silicon. The host Mac received no helper
installation or network mutation. The final network transaction implementation
was commit `6d050c7`.

Before activation, the guest had one enabled `Ethernet` service on the actual
default-route interface `en0`, automatic DNS, four unrelated baseline `utun`
interfaces, and no Mish route. The selected service's stable
SystemConfiguration identifier and transaction UUID were observed but are
redacted here. The root recovery record was a regular mode-`0600` schema-v2
file containing only that service identity, exact prior DNS, and one
root-generated transaction UUID.

Activation observed `off`, `pending`, then `applied`; Applied appeared only
after Core, DNS, the child-PID-correlated interface, and the exact route
partition were all confirmed. Exactly one new `utun4` appeared, the selected
service DNS became `198.18.0.1`, public HTTP returned 200, and Mish Traffic
observed the port-80 connection while System Proxy remained disabled. The
guest's `192.168.64.0/24` LAN and `224.0.0.251` multicast routes continued to
use `en0`; the NAT gateway remained reachable with no packet loss. A fictional
Bonjour service registered as `mish295-fixture._http._tcp.local`, resolved to
the guest's `.local` hostname and port, and the hostname resolved to the guest
addresses while TUN was active. This exercised macOS's native implicit
`.local` resolver shape, which contained no explicit nameserver or port.

| Scenario                   | Final real-macOS observation                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disable                    | A bounded retry was required in the network-change journey; the final result was `off` with all four components absent, automatic DNS restored, four baseline `utun` interfaces, no recovery record, and the original System Proxy digest.                                                                                                                                                                                                                                                               |
| Normal and forced app exit | SIGTERM and SIGKILL both removed the owned Core, `utun`, routes, DNS effect, journal, and watchdog without affecting the baseline interfaces or System Proxy.                                                                                                                                                                                                                                                                                                                                            |
| Helper exit and restart    | SIGKILL of only the Helper caused the independent watchdog to restore DNS and terminate Core. Launchd started a new Helper; the watchdog submission removed itself and left no recurring job.                                                                                                                                                                                                                                                                                                            |
| Core exit                  | SIGKILL of only Core restored automatic DNS, removed the owned interface and routes, cleared the exact journal, and converged to observed `off`.                                                                                                                                                                                                                                                                                                                                                         |
| Failed activation          | With the installed Helper deliberately booted out, activation returned `capability-unavailable` plus `helper-connection-failed`; DNS, routes, interfaces, and System Proxy did not change.                                                                                                                                                                                                                                                                                                               |
| Foreign DNS                | Replacing managed DNS with the documentation-only address `203.0.113.53` produced `observation-foreign` and recovery-required drift. Owner exit still terminated Core and removed routes, but did not overwrite the foreign value; the exact schema-v2 journal remained. A restarted Helper reported Core/interface/routes absent and DNS foreign and rejected new activation. Once DNS was returned to the exact managed value, Helper restart restored the prior automatic DNS and removed the record. |
| Service replacement        | Renaming `Ethernet` to `Ethernet-Replaced` preserved the BSD interface but changed the bound stable identity, so DNS and routes became foreign and never Applied. Cleanup removed Core and routes without retargeting or changing DNS and retained the original-identity journal. Restoring the original identity and restarting Helper completed exact DNS restoration.                                                                                                                                 |
| Interface off/on           | While the service was Disabled, the app reported recovery-required foreign DNS/routes and never Applied. After the same service returned, a fresh complete observation was required before Applied returned; the following bounded disable restored the exact baseline.                                                                                                                                                                                                                                  |
| Sleep/wake                 | Virtualization.framework rejected `pmset sleepnow` with `0xe00002e2`. During the established process suspend/continue simulation, public HTTP still returned 200, DNS remained managed, and LAN continued through `en0`; after continue all four components were freshly confirmed before final disable.                                                                                                                                                                                                 |

The first foreign-DNS journey exposed that a previously completed
`launchctl submit` watchdog could be restarted as a keep-alive job and consume a
later journal whose service and prior DNS happened to match. Commit `6d050c7`
made every journal/watchdog snapshot transaction-unique, made absent or
mismatched records non-mutating, and made a completed or blocked watchdog
remove its submitted job. The final foreign-DNS, service-replacement, Helper
exit, Core exit, and forced-owner runs all showed the schema-v2 journal retained
only for the exact unresolved transaction and zero stale watchdog jobs.
Final-head review then identified the narrower ordering where the watchdog
restores DNS and removes the exact record before the Helper reaps the same Core.
The follow-up makes that reap idempotent only after freshly confirming exact
prior DNS, retains non-mutating failure for an absent record with managed or
foreign DNS and for a present mismatched transaction, and covers the ordering
with a deterministic regression test.
The next final-head review identified a compare/write race and an interrupted
uninstall retry edge. DNS mutation now uses a synchronized, non-waiting,
exclusive `SCPreferences` compare-and-set transaction, with deterministic
apply and restore races proving a newly foreign value is never overwritten.
Removal treats only a genuinely missing recovery directory as already absent;
unsafe or invalid existing state remains blocking. A focused disposable Tart
rerun recorded the post-review SystemConfiguration write path.

The focused rerun used a new `mish-295-atomic-20260727` macOS 26.5 arm64 clone
from the same pinned Tahoe base digest. The final source reached `off`,
`pending`, and `applied`; all four components were confirmed, one new `utun4`
and the exact managed route partition appeared, service DNS became
`198.18.0.1`, public HTTP returned 200, Traffic observed the request, and the
LAN gateway plus multicast route remained on `en0`. Normal disable restored
automatic DNS, four baseline `utun` interfaces, zero Mish routes, and no
recovery record. With active DNS replaced by `203.0.113.53`, disable retained
that foreign value and the exact journal while still removing Core, `utun`, and
routes. Returning DNS to the managed value and restarting the Helper restored
automatic DNS and cleared the journal through the locked transaction.

For the interrupted-uninstall edge, the already-restored private recovery
directory was moved intact to the guest Trash before retrying uninstall. The
retry completed with `service: not-installed`, and a second retry was
idempotent. Final inspection found automatic DNS, four baseline `utun`
interfaces, zero Mish routes, the exact baseline System Proxy digest, and no
Helper, Core, plist, socket, installed state directory, process, or watchdog
job. The disposable clone, including its recoverable Trash item, was then
stopped and deleted.

The final source state passed all 80 `mish-platform-macos` unit tests plus its
integration and doc-test targets with `development-core-host`. The focused
stale-watchdog regression, all-target no-dependency Clippy gate, repository
`pnpm check:pr`, and the required GitHub Fast PR gate also passed.

`pnpm macos:tun:uninstall:tart` returned `not-installed`. The LaunchDaemon,
Helper, pinned Core, private socket and state directory, enrollment, network
recovery record, active and pending client keys, installer receipt, Core/app
processes, and watchdog jobs were absent. DNS exactly matched the prior
automatic state, the baseline `utun` count was four, Mish route count was zero,
and the complete System Proxy digest matched the pre-activation digest. The
disposable Issue #295 clone was then stopped and deleted.
