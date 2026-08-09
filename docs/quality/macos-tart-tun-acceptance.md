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

## Internal TUN Alpha package acceptance (Issue #296)

The final 2026-07-28 post-review run used the unique disposable clone
`mish-296-review-fix-20260728` of
`ghcr.io/cirruslabs/macos-tahoe-base:latest` at OCI digest
`sha256:a8e1c8305758643f513fdccdd829c2243687c60791083dea42f73f0b7aeb435c`.
The guest was macOS 26.5 on ARM64. Only the deterministic package output was
mounted read-only and copied to a local user-owned directory; the guest
received no repository checkout, Node.js, Rust, Homebrew, or runtime
Helper/Core download. Lifecycle commands ran with
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Direct privileged use of the VirtioFS
projection was rejected because its root-view ownership differed from the
invoking UID, with no installed state left behind.

The final `0.1.0-internal-tun-alpha.3` archive SHA-256 was
`4222c2b4c245e0fc5dc16fd796751e8b7925c4121662fbdcd0b61d2e3ac4e958`;
its manifest SHA-256 was
`0c529b3cc3cb309ebeb87e511ed9ea784b90922264a2978f2121adff29518417`.
Two consecutive builds produced both exact digests. Live package verification
confirmed three thin ARM64 Mach-O executables, ad-hoc-only Mish controller and
Helper signatures with no Team Identifier, Helper contract version 3, and the
unchanged pinned Mihomo v1.19.29 digest.

The explicit Tart terminal-authorization boundary installed the package and
returned `healthy-disabled`. The Cirrus base image configures passwordless
`sudo`, so this run confirms the fixed root transaction but does not claim a
visible password prompt; the ordinary package command still uses the native
administrator dialog, which was later verified on the maintainer Mac.

The controller was copied first to the private mode-`0500` user staging path
and then to a root-owned mode-`0700` temporary directory. The root copy was
mode `0500`, single-link, exact-size and exact-digest verified before
execution, and no root staging directory remained afterward. A concurrent
same-UID process atomically replaced the user staging controller with a
same-size tampered copy; repair failed with
`privileged-controller-stage-digest-mismatch`, never entered the root
transaction, and the existing service remained authenticated and
`healthy-disabled`.

The installed LaunchDaemon was `root:wheel` mode `0644`; Helper and Core were
`root:wheel` mode `0555`; enrollment was `root:wheel` mode `0600`; the public
root receipt was mode `0444`; the private socket was `admin:daemon` mode
`0600`; and the sealed state directory was `root:daemon` mode `0700`. The
active P-256 client key and user receipt were `admin:staff` mode `0600`.
Authenticated health matched protocol 3, Helper version 3, installation
identity, key identifier, and enrollment generation 1.

An identical reinstall preserved the same installation identity, key
identifier, and generation. A cold guest restart remained healthy and
disabled. Changing the root receipt installing UID from 501 to 502 made
uninstall reject `existing-installation-owner-rejected`; the running Helper
PID remained 327 before and after the attempt. Restoring the receipt and then
temporarily removing only enrollment made uninstall reject
`uninstall-authorization-rejected`; the same Helper PID and all global
artifacts remained. Both records were restored before Health succeeded again.

Changing only the installed Helper mode to `0500` made health reject the exact
fixed artifact. Repair restored the package, retained the same
identity/key/generation, and returned to authenticated `healthy-disabled`.
After a clean uninstall, a root watcher repeated that exact mode drift between
the next install transaction and post-install Health. Install returned
`post-install-health-failed`, automatically removed every fixed root artifact,
and also removed the user receipt plus active and pending private keys. Status
then returned `not-installed`. A final clean Install, authenticated Health, and
Uninstall all succeeded.

No Mihomo Core ran during the package journey. The guest retained its four
baseline `utun` interfaces. System Proxy and DNS SHA-256 snapshots were
byte-for-byte unchanged before install, after repair, and after uninstall.
The guest's general IPv4 route table changed independently across cold boots,
so its whole-table digest is not used as acceptance evidence; fresh Helper
observation confirmed that no Mish-owned interface, routes, or DNS effects
were present.

Uninstall returned `not-installed`. The launchd job, LaunchDaemon, Helper,
Core, enrollment, socket/state, root and user receipts, installer staging, and
active/pending client keys were absent. No Mish Helper or Core process
remained. The host Mac received no Helper installation or network mutation,
and the disposable post-review clone was stopped and deleted after retaining
this redacted evidence. Only the two stopped official OCI base caches remained.

Later maintainer hands-on testing reproduced a real-host cold-start race on
the `.2` controller. Root artifacts appeared at 12:50:13, launchd reported the
Helper process at 12:50:14, and the private socket became ready at 12:50:15.
The one-shot post-install Health probe ran before that socket existed, reported
`core-host-unavailable`, and correctly rolled the installation back. The `.3`
controller retries only that unavailable state for a bounded 15-second
readiness window. Its new regression test first failed against the one-shot
implementation and then passed with the bounded retry; protocol and trust
errors remain non-retryable.

The exact `.3` package then installed successfully through the visible native
administrator dialog on the maintainer Mac. Health reported protocol 3,
Helper version 3, generation 1, and `healthy-disabled`; Status reported
`installed`; launchd kept only the Helper running and no Mihomo Core process
existed. DNS SHA-256
`fb0adf456747ca84c2c407b20d20eedc79f993e5c3b8850a850b2d71b834b968`,
System Proxy SHA-256
`a85bb673159212cb8d463b52c72baee4bf40693c2d5805b7a2a1ca6588984a18`,
and the `utun0` through `utun7` baseline were unchanged.

## Transactional Internal TUN Alpha maintenance (Issue #298)

The 2026-07-28 acceptance used the uniquely named disposable clone
`mish-298-transactional-20260728` on macOS 26.5 ARM64. The accepted `.4`
baseline manifest SHA-256 was
`4955c694bbc983c8591328f9736d13c150ded70532a3874fdd1c392e33001be2`.
The full transactional walkthrough used a pre-review `.5` archive SHA-256 of
`731f75bbef949a83ff20002721d9cc0e8cafa8dc91cbea1d6a32d9a956e8ac9d`
and its manifest SHA-256 was
`342fa33c72749042bbe64b51847cbd689651a1005a8233fb516e4854e750c573`.

The `.4` package installed with generation 1 and key identifier
`ca8c7074257678dbec08983553bc61c8ab985da56ebaa47d12cf6e324471f392`.
The packaged app started a real root-owned Mihomo TUN Core, the UI confirmed
Virtual Interface capture, the guest had the Mish-owned MTU-9000 interface and
managed DNS, and `curl https://example.com` returned HTTP/2 200. Powering off
the VM while Capture was active left the next cold boot on the exact original
Ethernet DNS, proxy, default route, and four non-Mish `utun` interfaces.

An injected `.5` failure immediately after `core-replaced` returned
`maintenance-upgrade-failed-rolled-back:maintenance-injected-failure:CoreReplaced`.
The durable journal retained admitted package, service, enrollment, artifact,
Capture, commit-point, and compensation evidence without Profile, generated
configuration, private-key, or raw unrelated network data. It confirmed all
four prior Capture components before reconciliation, all four absent
afterwards, and restored the verified `.4` Helper, Core, plist, enrollment,
receipt, and exact prior network state. The key identifier and generation did
not change. The candidate app exposed the bounded Repair Required semantic
notification instead of claiming success or restoring Capture.

A normal active `.4` to `.5` upgrade committed a new installation identity,
preserved the same key and generation, launched the verified service, and
restored real TUN Capture through the app marker. An identical active `.5`
reinstall returned `active-unchanged`. A separately built lower `.4`
acceptance candidate using the current controller returned
`maintenance-downgrade-rejected` before mutation.

Explicit repair was then aborted at the exact `enrollment-committed` boundary.
The journal remained nonterminal with the accepted operation UUID and
confirmed-disabled Capture evidence. After a full VM restart, Status returned
`recovery-required`; Helper, Core, watchdog, and Mish network effects were
absent. Repair first compensated the interrupted journal, retried the bounded
Helper startup observation, and then completed a fresh verified transaction as
`healthy-disabled`. A separate installed-Helper mode fault produced the same
closed Recovery Required state and did not advertise Helper availability until
the administrator restored the expected fixed-artifact mode and repair
confirmed recovery.

For final cleanup, the recovered `.5` app again started real TUN Capture and
`curl https://example.com` returned HTTP/2 200. Active uninstall reconciled
Capture through the authenticated operation and returned `not-installed`.
The LaunchDaemon, Helper, Core, enrollment, receipt, maintenance journal and
backup, socket and state directory, user receipt, and client key were absent.
No Mish app, Helper, Core, or watchdog process remained. Ethernet DNS had no
explicit server, System Proxy matched the original disabled dictionary, the
default route was again `192.168.64.1` on `en0`, and the exact original
`utun0` through `utun3` list and MTUs were restored.

After review tightened administrator-cancellation Capture restoration and
terminal-journal uninstall authorization, the final `.5` candidate was rebuilt
with archive SHA-256
`446e03d95397b168973ec4e847610a244417646cf68c01ef38aed7eeeb033eb9`
and manifest SHA-256
`6c8650b88a2b65bb3b94b52170af52538010a7fafdaed7e2a72b6a9578fcf5b5`.
A focused rerun on the same disposable clone installed a clean `.4` service
with generation 1, observed the expected `recovery-required` stale-version
status from the final `.5` controller, and then uninstalled that healthy
terminal-journal installation through the final controller. Status returned
`not-installed`; all fixed root and user-owned TUN artifacts were absent; and
Ethernet DNS, System Proxy, the `en0` default route, and `utun0` through
`utun3` exactly matched the pre-install baseline. The final candidate's active
Capture upgrade and native administrator-cancellation path remain part of the
explicit human acceptance gate rather than being inferred from the focused
rerun.

The final 2026-07-29 follow-up on the same disposable clone used archive
SHA-256
`e61d09a20cdc75d25416df41219a916300cf299f7b13a89a0df528632aa93b7e`
and package-manifest SHA-256
`f5e65285e602be53ee4f3b524287676cc5ff421984026a9f48d9e0293f9e1d38`.
The app preference was returned to `launchBehavior: off` before this run.
A real active root Core produced `utun4` at MTU 9000, managed DNS
`198.18.0.1`, disabled Ethernet HTTP/HTTPS/SOCKS proxies, and public HTTP 200.
Installation generation 1, installation identity
`a2ac27e277591cca0c37d8fb81ae96cccae7c0f49b870c8c3f444124935d0de7`,
key identifier
`510f85c23cdb7b5151ac0319cb982962b3ac5b9623d7e2f4bd24a764188b29af`,
and the client-key file SHA-256
`6c583dd5e8a6200e92bf7f9611c7215aa43e970491db807eb3e4833b236dd297`
remained continuous through repair and replacement.

Failure injection at `helper-replaced` returned
`maintenance-upgrade-failed-rolled-back:maintenance-injected-failure:HelperReplaced`.
Five seconds later the final implementation had no app or Core, no Mish TUN or
managed DNS, one healthy launchd Helper with no prior exit, and a regular
user-owned mode-`0600` version-bound Capture marker. The journal was terminal
`rolled-back`, commit point `verified`, with artifact, enrollment, network, and
cleanup compensation all `restored`. An ordinary app start retained that
marker and stayed disabled for the two-minute observation window rather than
guessing or reporting restored Capture; this is the accepted bounded Recovery
Required outcome, not evidence of automatic Capture restoration.

Uninstall was then exercised from that bounded recovery state and returned
`service: not-installed`. Launchd registration, Helper, pinned Core, socket,
enrollment, root and user receipts, maintenance journal and backup, client key,
restore marker, and maintenance lock were absent. No Mish TUN or managed DNS
remained; Ethernet HTTP, HTTPS, and SOCKS proxy settings were all disabled and
public HTTP returned 200. The package directory itself remained only as the
user-owned acceptance input.

That candidate also exposed and therefore did not pass one restoration edge:
after rollback, the Helper could confirm a real restored TUN while the shared
Capture projection remained Recovery Required. The app deleted the marker from
the Helper observation alone and displayed a stopped session even though the
root Core, `utun4`, and managed DNS were active. This hybrid state was rejected
as acceptance evidence.

After the source-development TUN boundary was added, the corrected final
candidate was rebuilt from the final source state with archive SHA-256
`150c5c486c8de981a4feeac2c840466d628b1ff125542e840bed41d35dd5bca3`
and package-manifest SHA-256
`d96f31b79cb366fd00ce7b67dcc38e0cd27c2ac041995c1984aa1eb1ce87ee54`.
It installed as `healthy-disabled` with generation 1, installation identity
`00601c93a4d72bbaf8eec4880e82caa7e6067a6570cd610db02e0d7b6192e9ae`,
and key identifier
`5a30a5976fc27e64445f4814d17bc3491208b1fa88906cc4d1c3743b49f0a9c2`.
The packaged app then started the real root Core, produced `utun4` at MTU 9000
with managed DNS `198.18.0.1`, kept Ethernet HTTP, HTTPS, and SOCKS proxies
disabled, and returned public HTTP 200. Its accessibility projection reported
`Virtual Interface, selected, running`.

Failure injection at `helper-replaced` again returned the exact typed
`maintenance-upgrade-failed-rolled-back:maintenance-injected-failure:HelperReplaced`
outcome. The controller stopped the app and Core, restored the verified
service, removed `utun4` and managed DNS, and retained the version-bound marker.
On ordinary startup, the corrected dual-evidence gate did not accept Helper
effects without a matching Applied shared Capture projection. It safely
disabled the unconfirmed attempt and retained the marker: no root Core, Mish
interface, or Mish DNS remained; System Proxy stayed off; and the UI reported
`Virtual Interface, selected, not running`, that the prior capture state had
been restored, and that the Internal TUN service could be installed or repaired
in Settings. It never reproduced the rejected active-but-unprojected hybrid
state.

Uninstall from that bounded recovery state returned `service: not-installed`.
The LaunchDaemon, Helper, Core, socket, enrollment, root and user receipts,
client key, restore marker, and Mish-owned network effects were absent.
The exact original `utun0` through `utun3` list was restored. DNS SHA-256
`107b83e6c47cffe00657651f789e351801b60fe144f117e6a57fc5dde6f89dca`
and System Proxy SHA-256
`d06cf10f79ee90d7f59fc10d3467c11282bca1002f942301a97c13dbf5c66f28`
matched the pre-install baselines byte for byte.

The 2026-07-30 residual acceptance reused the stopped, previously uninstalled
disposable clone with delivery head
`badac85f2993c3518a263e0f65b17444bf238ab2`. The final package archive
SHA-256 was
`eba6de56243149ad2579029a89a9e1d41edee4839f5ade1f4d7db2781eda2a28`
and its manifest SHA-256 was
`0769ea80b79934daecd41774c33d6328a6656d3aaef06c06947cc57fbbb0e080`.
The clean baseline reported `not-installed`, `utun0` through `utun3`, default
route `192.168.64.1` on `en0`, automatic Ethernet DNS, and the same System
Proxy digest recorded above.

The package installed as `healthy-disabled`, generation 1. The packaged app
started a real root Core, created `utun4` at MTU 9000, installed the complete
managed route partition and scoped `198.18.0.1` DNS, kept System Proxy
byte-for-byte unchanged, returned public HTTP 200, and projected Virtual
Interface selected and running. An identical install while Capture was active
returned `active-unchanged`, retained generation 1, and kept packet flow
confirmed.

An explicit repair failure after `helper-replaced` returned
`maintenance-upgrade-failed-rolled-back:maintenance-injected-failure:HelperReplaced`.
Rollback removed the active Core, `utun4`, and managed DNS and restored the
verified Helper. On the following ordinary startup, the app briefly attempted
Capture restoration but did not project Applied from Helper effects alone:
at 15 seconds the real Core and `utun4` were present while the UI remained
selected and not running. By the next bounded observation at approximately 35
seconds, compensation had stopped the Core, removed `utun4`, restored
automatic DNS, and retained the version-bound restore marker. The rejected
active-but-unprojected hybrid state therefore never became a terminal success.

Uninstall from that bounded Recovery Required state returned `not-installed`.
The LaunchDaemon, Helper, Core, socket, enrollment, receipts, client key,
maintenance evidence, restore marker, and Mish-owned network effects were
absent. The exact `utun0` through `utun3` list, `en0` default route, automatic
DNS SHA-256
`dd527661f63e293ce0da027adb4c50e7e9ef3936f130853d8ae3f695b4177ddc`,
and System Proxy SHA-256
`d06cf10f79ee90d7f59fc10d3467c11282bca1002f942301a97c13dbf5c66f28`
matched the start of this residual run.

The 2026-07-31 post-review walkthrough reused that stopped, uninstalled
disposable clone and exercised the rollback-admission fixes through final
source commit `615f323`. The final package was promoted to
`0.1.0-internal-tun-alpha.6` because its privileged controller differs from the
previously exercised `.5` identity. Its archive SHA-256 was
`92a90c98e51dd39b4e799782e072ba2b90d42df4c64a6748521b91f55af1bdf4`,
its manifest SHA-256 was
`165d4afdf04544607b78eec790d5a111c5240f3a866b48a45489245627ea559e`,
and its controller SHA-256 was
`8403afcfc7281f79da4f387a36bb7cbd037e54c818bdc321106dedb82aa50442`.

A clean `.5` install and identical reinstall retained generation 1, the exact
installation identity, and the exact key identifier. The `.6` controller
observed that installation as repair-required, upgraded it to healthy-disabled,
and preserved all three values. An identical `.6` reinstall then returned
`active-unchanged`.

The first real failure injection caught an ordering defect in the new
commit-boundary recheck: launchd had already been intentionally stopped, so a
second check that still required the service to be running rejected a healthy
prior installation. The final implementation separates initial
package/service/enrollment admission from the pre-backup static artifact and
enrollment recheck. A repeated `helper-replaced` failure then returned the
exact `maintenance-upgrade-failed-rolled-back` outcome and restored the prior
service rather than admitting changed artifacts.

For the corrupt-prior case, the installed Core mode was changed from the
receipt's fixed mode before repair. The transaction did not admit that
installation as a rollback target. Failure after `helper-replaced` returned
`maintenance-install-failed-bounded-disabled`; the terminal journal recorded
`artifacts.old: null`, `bounded-disabled` artifact compensation, and no
receipt, enrollment, Helper, Core, plist, socket, or launchd service. The final
`.6` controller then uninstalled that exact bounded state as `not-installed`.

Final inspection found no root or user receipt, enrollment, client or pending
key, maintenance journal, restore marker, lock, socket/state directory,
Helper, Core, plist, process, or launchd job. The guest retained only
`utun0` through `utun3`, the default route remained `192.168.64.1` on `en0`,
Ethernet DNS was automatic, public HTTPS returned 200, and System Proxy
SHA-256
`d06cf10f79ee90d7f59fc10d3467c11282bca1002f942301a97c13dbf5c66f28`
matched the pre-install baseline. This automated disposable-host walkthrough
does not replace the explicit human acceptance gate.

## Immutable Internal TUN Alpha staging evidence (Issue #299)

### Historical `.3` local evidence

The local delivery-boundary reproduction used Apple Silicon macOS and the
accepted `0.1.0-internal-tun-alpha.3` package. It did not install the package,
request administrator authorization, run Mihomo Core, change network state,
read a secret, use a Developer ID identity, contact Apple, create a tag or
Release, or publish an artifact.

The package rebuild used fixed source-date and Rust path-remapping inputs. The
result contained no absolute user or GitHub-runner checkout path. Its archive
SHA-256 was
`af044faaea9a80917e778c3a54720871553a7b026d051ce33f04ca18d8291667`;
the package manifest SHA-256 was
`87d1c3db28ff1288d96db4d245937cc9424c4900e1a62fecf58c12d3e9687470`.
The manifest bound these exact privileged inputs:

| Input                 | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Lifecycle controller  | `1cbb658d4c827eb9292c82c14caec50636ec9ae6ce10ef1f033f085e971ae5e3` |
| Helper                | `391c33ed01114e012cd69a6efd0ebae80efe386d796af4fd00a7b51560bd6703` |
| Mihomo v1.19.29 Core  | `ec66e3e883bdc3fca06753784e324e08921e13239f8e945587cb1bfbf4c6b936` |
| LaunchDaemon template | `9a66195d4e52ed6dc7493372b810b48a4c1aa8df7b5e885be16ba8a8354adee1` |

Two candidate generations were separated across different wall-clock seconds
and by an intervening complete package verification that changed source access
times. Both used the same fixed synthetic workflow/run identity. The HFS+
volume dates and volume identifier plus ISO9660 descriptor, directory-record,
and system-use dates were normalized by reviewed tooling. The complete DMG,
copied package manifest, SPDX SBOM, in-toto/SLSA provenance, checksum file, and
candidate manifest were byte-identical. The DMG SHA-256 was
`82f1da30f21950fdccca5b261d2fba38655db616609f015fbc646300542c201d`;
the candidate bundle SHA-256 was
`88fa6fbad3b862d5c74b1b2aa96bebd7d67bae7fa72f6177b1d403e9cba69690`.

The independent verifier mounted both DMGs as read-only HFS filesystems and
accepted only the closed 12-file package plus its manifest. It checked exact
owner/mode/link state, thin ARM64 code, ad-hoc-only Mish signatures, Helper
version 3, protocol version 3, the pinned Core version/digest, closed lifecycle
actions, disabled `MISH_TUN_SERVICE_ALLOW_TUN=0`, enrollment/profile isolation,
source-equal legal resources, README boundaries, SBOM, provenance, and
SHA-256. Both verification evidence files were byte-identical at
`9e10c56def40f6faec8447ed1ea9304dfcd14e1a39693332cca0ecec8194b16d`.

The provenance separately bound the exact lockfiles:

| Lockfile           | SHA-256                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `Cargo.lock`       | `6a3ca60c868d0fa8d287965464c34562a2eb4d21f85936ba4f20508027e947fe` |
| `pnpm-lock.yaml`   | `6e10fa592a1428a78489b92d6df7f8a33a254f7bbf08870160a1300727451e57` |
| `skills-lock.json` | `37b2aef28fbcf70bd11b08b8e42323a481fb9b53d623c26de531f32f88391794` |

The finalizer then bound candidate artifact fixture ID `456` and independent
verification fixture ID `789` into one non-overwriting stage. A second
read-only confirmation addressed the final fixture by immutable ID `999`,
remounted the DMG, repeated all checks, and confirmed final bundle SHA-256
`84ff13fbbf02d2ec02bf94a666f9d7540c2141570775ea307ca192044be82c6a`.
The immutable input-binding record SHA-256 was
`6467ee03e0c41f984a7ca5672db68c276e93942f5d887a98f77eda9014f03e73`;
it records both source artifact IDs and names plus the candidate bundle,
verification evidence, and run identity.
These numeric IDs are deliberately synthetic local reproduction inputs; they
are not represented as GitHub staging evidence.

At that historical delivery boundary, the read-only live GitHub trust audit
observed latest `main` run
`30331812868` with both package jobs at zero executed steps and status
`disabled-fail-closed`. Consequently the `.3` evidence did not claim a hosted
Internal TUN Alpha artifact.

### Current-main hosted reconciliation, 2026-08-09

The reconciled source, workflow, and tooling identity is the exact reviewed
`main` SHA `d925f0abd09c1f153cc54f2e2bcea054b6477b1e`. This baseline includes the
current `.7` Internal TUN Alpha package, Helper version 6, the transactional
package and TUN lifecycle machines, the installation/enrollment boundary, the
current CI policy, and the completed coordinator-only Core lifecycle migration.

[Workflow run 31296492082](https://github.com/Asuka109/mish/actions/runs/31296492082)
completed every substantive Internal TUN job: frozen-source admission,
candidate build and package policy, independent read-only candidate
verification, final immutable binding, and read-only confirmation of the exact
final artifact on a fresh Apple Silicon runner. The other credential-free
profiles were conditionally skipped and are not counted as Internal TUN
successes.

The run produced these immutable artifact identities:

| Role         | Artifact ID  | Retention | Bound identity                                                                                                                                             |
| ------------ | ------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate    | `9033272088` | 1 day     | `mish-internal-tun-alpha-candidate-0.1.0-internal-tun-alpha.7-d925f0abd09c1f153cc54f2e2bcea054b6477b1e-31296492082-1`                                      |
| Verification | `9033280206` | 1 day     | `mish-internal-tun-alpha-verification-0.1.0-internal-tun-alpha.7-d925f0abd09c1f153cc54f2e2bcea054b6477b1e-31296492082-1`                                   |
| Final stage  | `9033283912` | 14 days   | `mish-internal-tun-alpha-stage-0.1.0-internal-tun-alpha.7-d925f0abd09c1f153cc54f2e2bcea054b6477b1e-d925f0abd09c1f153cc54f2e2bcea054b6477b1e-31296492082-1` |

The GitHub artifact service reports the final download digest
`sha256:2ce13e108ac0efeac542767c70bcfa42ce2e153202ff75065a1ccc5986c0d793`.
After download by that exact artifact identity, the repository verifier
remounted and reverified the hosted DMG read-only. It confirmed final bundle
SHA-256 `ac340b90f4565b62b3b576c5f28a0699b1cfedfab80227f1c1db842d83243cb2`
and DMG SHA-256
`8b8ea0dda5ac5d2738ff3cc0780c1f0666b20d789c2b44bcb5ace83af71751db`.

The final manifest binds package manifest
`e8d3015dc80f9b1f17bf047fca2606204b9bc20bde27d88bf5663183c1b26606`,
SPDX SBOM
`4ca5f5f4859c824f520c3493660a74770388179f7a393aa811961b0dfec77274`,
in-toto/SLSA provenance
`5962070f8c1132317e509061a2be1df1fa28636abee4cb7f65b6f5e4bc468c73`,
verification evidence
`8c70965b15af76e160c5343f7ed1f921b38619572694a86c214e72edc392a555`,
and immutable input record
`18403090edba12efa2a7b014143589a69328da650390f43d3212d87721f47f46`.
The verified privileged identities are controller
`96c871a6a7a94237b9de429c0fc60da9caa8f4b94e89b86e32ac6d822342c379`,
Helper `eb7b7f0392ffdf70b542975cce6935e9fb98ef92cca5570a1df31e984b782d4f`,
Mihomo v1.19.29 Core
`ec66e3e883bdc3fca06753784e324e08921e13239f8e945587cb1bfbf4c6b936`,
and LaunchDaemon template
`7e30062801c96b5968f7cfc3e6afe8cf5feb5bc6da99c8c1b5d8d37a0df30ea8`.
Protocol version 3 and installation identity scheme
`sha256-helper-core-rendered-plist-v1` remained exact.

The independent evidence records the focused install surface, closed embedded
layout, ownership/mode/link policy, exact Helper/Core versions and digests,
closed protocol, enrollment boundary, profile isolation, source/tooling and
lockfiles, SBOM/provenance, and SHA-256 checks. The final DMG contains only the
accepted drag-to-Applications surface and embedded app payload. It contains no
Developer ID, notarization, `SMAppService`, signed XPC, secret, mutable download,
public Release, updater installation, or deployment claim.

A separate local Apple Silicon reproduction built the same frozen source twice
with the same synthetic run identity, with a complete package verification
between builds. Every candidate file was byte-identical; both independent
verification evidence files were byte-identical. The local DMG SHA-256 was
`8410ca3024870bfa6028e459f111fa77bb07b4b166e806819c51df0df3c5e774`,
the candidate bundle SHA-256 was
`006f4f3490d249dd4dfd7377702fb34a596a3437d14e831cf85a1ea38ad1ec0f`,
the verification evidence SHA-256 was
`c680dc68568c6ec4908eaa321051c702dfa403bb4b8d7d4f568fc00a163d7386`,
and the final local bundle SHA-256 was
`c6d0b8b52ac5c5a41ba58733604fcee1702b9c9d842d155e5c1bdab31c4cf733`.

The local package verifier, Internal TUN and workflow-policy fixtures, trusted
boundary adversarial fixture, macOS bundle/security suite, and `pnpm check:pr`
passed. The latter covered 549 Web tests, 10 RPC client tests, 5 mock bridge
tests, 148 script tests, 38 SimulatedHost Rust scenarios, and 8 Chromium
scenarios, including the deterministic coordinator-only Core lifecycle check.

This staging did not install the package, request administrator authorization,
run Core, or mutate TUN, routes, DNS, or System Proxy. Operator documentation
continues to state the ad-hoc Internal Alpha boundary, app-scoped Open Anyway
flow, explicit administrator-authorized install/repair/removal, mode-`0600`
same-user-key limitation, Apple Silicon macOS 13+ support, recovery/uninstall
route, and internal non-public scope. The live production trust audit remains
`disabled-fail-closed`; successful credential-free staging does not activate
Developer ID signing, notarization, publication, or deployment.

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

Final review also made unsupported virtual services without BSD names
non-blocking for the eligible physical-service inventory and made simultaneous
watchdog/Helper restoration converge after an exact-prior DNS reobservation.
The deterministic concurrent-recovery regression covers the exact-prior winner;
the existing conservative cases continue to reject managed, foreign, partial,
or unknown values. Helper reap and explicit stop both retain the independent
watchdog whenever DNS restoration is still pending, so temporary
preferences-lock contention cannot cancel the watchdog's bounded retry loop.
The Helper retains that exact pending transaction after stopping Core; later
status and start handling retry it, accept only an exact-prior observation
after the watchdog wins, clear the in-memory applied bit, and converge to
observed off without a restart. The root journal now records an atomic
prepared/applied phase: a watchdog cannot consume prior DNS while apply is
still in flight, while managed DNS remains recoverable if apply dies before
marking the record. Closed-command client deadlines now cover every sequential
system observation and default-route lookup, including Enable's complete
post-apply status. Cold-start recovery also runs immediately after the root
check and before new-request prerequisites; a deterministic regression removes
the exact journal and restores DNS even when the pinned Core is absent.

The 2026-07-27 final-head rerun used the unique disposable clone
`mish-295-final-20260727` from the same pinned Tahoe base digest and exercised
commit `8ec1c14`. The guest again ran macOS 26.5 on Apple Silicon; the
maintainer host received no Helper installation or network mutation. The
repository harness observed `off`, `pending`, then `applied`, with Core, DNS,
interface, and routes all confirmed. It recorded one new `utun4`, managed DNS
`198.18.0.1`, public HTTP 200, and a matching Traffic connection while System
Proxy remained disabled. The LAN gateway and `224.0.0.251` route both remained
on `en0`.

The live root journal was a single-link mode-`0600` file with outer recovery
schema 1, inner managed-state schema 2, and phase `applied`; its service
interface was the dynamically selected `en0`, its prior DNS list was empty
(automatic), and its transaction ID had canonical UUID length. Disable
returned to observed `off` with all four components absent, automatic DNS, four
baseline `utun` interfaces, zero Mish routes, no journal, and the exact baseline
System Proxy digest. Uninstall returned `not-installed`; the Helper
registration, root state directory, installed binary, related processes, and
watchdogs were absent. The clone, including its guest-only discarded clone
attempts, was then stopped and deleted; only the two stopped OCI base caches
remained.

The final source state passed all 86 `mish-platform-macos` unit tests plus its
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
