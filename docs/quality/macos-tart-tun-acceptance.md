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
