# Mobile Runtime Reference Review

## Metadata

- Date: 2026-07-20
- Scope: Android and iOS Mihomo integration references
- Sources: Upstream public repositories and official platform documentation

## Purpose

This review records implementation evidence for Mish's mobile runtime plan. It
separates reusable architecture from project-specific code and does not make a
third-party repository an implementation authority. Durable Mish ownership and
security decisions live in
[`../architecture/mobile-runtime-integration.md`](../architecture/mobile-runtime-integration.md).

## Source checkpoints

| Source                                                                     | Checkpoint                                                                                                               | Relevant evidence                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| [Clash Mi](https://github.com/KaringX/clashmi)                             | `main` at [`c196fe8`](https://github.com/KaringX/clashmi/commit/c196fe8143904c13c44c1bfc5960a690a4a71aec)                | Apple Packet Tunnel composition, platform interface, and embedded `Libclash` calls; Android prebuilt-library packaging reference |
| [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)      | `dev` at [`971dd37`](https://github.com/clash-verge-rev/clash-verge-rev/commit/971dd37965df1cdb4d3aa7eed7f2e4293a53102d) | Serialized Core lifecycle, generated runtime configuration, sidecar/service selection, failure rollback, and command ownership   |
| [Clash Meta for Android](https://github.com/MetaCubeX/ClashMetaForAndroid) | `main` at [`82b73a4`](https://github.com/MetaCubeX/ClashMetaForAndroid/commit/82b73a4bca24f1606e4b443bc9574cf1758c9693)  | Reproducible Android Go/C/JNI/Kotlin integration and `VpnService` ownership                                                      |
| [FlClash](https://github.com/chen08209/FlClash)                            | `main` at [`7c83185`](https://github.com/chen08209/FlClash/commit/7c831855efedceb1a72bd0b4c18da026593d0853)              | Go `c-shared` Android builds, per-ABI packaging, TUN file-descriptor handoff, and service lifecycle                              |

These moving branches are architectural references only. Any code reuse must
pin an exact commit, preserve license obligations, and pass an independent
security and reproducibility review.

## Clash Mi mobile composition

Clash Mi keeps the Apple Packet Tunnel target thin. Its iOS
`PacketTunnelProvider` subclasses a shared `ExtensionProvider`, while the shared
provider loads configuration, starts the embedded Core, handles app messages,
and owns tunnel stop and restart behavior. Its platform interface translates
Core requests into `NEPacketTunnelNetworkSettings`, including addresses, DNS,
routes, exclusions, proxy settings, and MTU.

This separation supports the Mish direction:

- the main application configures and observes the tunnel but does not own its
  lifetime;
- the Packet Tunnel extension owns the embedded Core and packet flow;
- one bounded provider-message protocol carries commands and snapshots; and
- platform networking details stay outside the shared React product layer.

Clash Mi is not a reproducible binary baseline for Mish. The public Android
tree refers to a prebuilt `libclash.aar`, and the Apple integration expects a
`Libclash` framework produced outside the visible shell code. Mish must build
its own native artifacts from a pinned Mihomo source checkpoint.

The Apple platform interface also obtains the tunnel file descriptor through a
private key path with a descriptor-scan fallback. This is useful feasibility
evidence, but it is a fragile implementation detail rather than an API contract.
Mish must audit the chosen handoff on every supported iOS release and fail
explicitly when no supported path is available.

## Clash Verge Rev lifecycle composition

Clash Verge Rev is a desktop reference, not a mobile Core integration. Its
useful patterns are above the process mechanism:

- serialize start, stop, restart, configuration replacement, and service
  handoff;
- make repeated start and stop commands idempotent;
- generate and validate the effective configuration before activation;
- publish the selected running mode and authoritative result after transition;
- roll state back to `not running` after a failed start; and
- prevent application exit, configuration mutation, and lifecycle transitions
  from racing each other.

Its sidecar executable, shell plugin, desktop service, process signals, tray,
and privileged-service handoff must not enter a mobile build. Android maps the
same lifecycle semantics onto `VpnService` plus an embedded library. iOS maps
them onto `NETunnelProviderManager`, a Packet Tunnel extension, and an embedded
framework.

## Android implementation evidence

Clash Meta for Android and FlClash demonstrate the parts that Clash Mi's public
Android packaging does not make reproducible:

- compile a pinned Go wrapper with `CGO_ENABLED=1` and `-buildmode=c-shared`;
- package one `.so` for each supported Android ABI;
- expose a narrow C/JNI boundary instead of the complete Go package graph;
- let Kotlin `VpnService` request permission, establish the TUN interface,
  protect Core sockets, and own foreground lifetime; and
- keep the VPN alive independently of the activity and WebView.

Mish should reuse these patterns without inheriting their product state,
configuration ownership, telemetry choices, update paths, or opaque artifacts.

## Adopt, adapt, and reject

| Decision                                                         | Reference       | Mish position                                 |
| ---------------------------------------------------------------- | --------------- | --------------------------------------------- |
| Packet Tunnel owns Apple Core lifetime                           | Clash Mi        | Adopt                                         |
| Platform interface translates Core TUN requirements              | Clash Mi        | Adopt behind a Mish-owned ABI                 |
| Serialized start/stop/restart and validated activation           | Clash Verge Rev | Adopt as application semantics                |
| Android `VpnService` owns TUN and foreground lifetime            | CMFA, FlClash   | Adopt                                         |
| Pinned Go `c-shared` artifacts per Android ABI                   | CMFA, FlClash   | Adopt with reproducible scripts and checksums |
| Desktop sidecar or local Axum bridge on mobile                   | Clash Verge Rev | Reject                                        |
| Prebuilt Android AAR without reproducible source inputs          | Clash Mi        | Reject                                        |
| Private Apple file-descriptor access as an assumed stable API    | Clash Mi        | Treat as a gated feasibility risk             |
| Third-party application state or configuration as Mish authority | All references  | Reject                                        |

## Resulting direction

Mish will own one mobile command, event, configuration, and native-Core
contract. Android is the first device-debug target. iOS engineering proceeds in
parallel through shell, extension, bridge, and XCFramework preparation, while
signed device and TestFlight validation remain explicit later gates. The
complete boundary is specified in
[`../architecture/mobile-runtime-integration.md`](../architecture/mobile-runtime-integration.md),
and the evidence gates are specified in
[`../quality/mobile-validation.md`](../quality/mobile-validation.md).
