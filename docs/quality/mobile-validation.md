# Mobile Validation

## Purpose

This contract separates a responsive browser preview, a compiled mobile shell,
an installable application, and a proven device VPN. No earlier evidence level
may be presented as proof of a later one.

## Evidence levels

| Level                  | Claim allowed                                               | Required evidence                                                            |
| ---------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Responsive Web         | Shared content fits representative phone viewports          | Real-browser layout, navigation, input, and accessibility checks             |
| Compiled shell         | Native project and shared Web assets compile                | Platform toolchain build and generated-project integrity checks              |
| Installable app        | A signed or debug artifact installs and launches            | Device or emulator installation, offline assets, and native-client bootstrap |
| Native fixture         | Mobile UI receives typed native snapshots and commands      | Plugin contract tests, reconnect, cancellation, and lifecycle fixtures       |
| Device VPN             | Real device traffic traverses the embedded Core             | Permission, TCP, UDP, DNS, routing, lifecycle, recovery, and stop evidence   |
| Distribution candidate | Store-shaped artifact preserves capabilities and provenance | Signing, entitlement, artifact inspection, SBOM, privacy, and update gates   |

## Shared shell coverage

Automated coverage must prove:

- explicit `browser`, `desktop`, and `mobile` client selection;
- Android and iOS platform recipes over the same route metadata;
- five stable mobile destinations with visible labels;
- Home, Routes, Profiles, Activity, and Settings deep links;
- `/traffic`, `/events`, and Diagnostics selecting the correct Activity child;
- per-tab child-route and scroll-state preservation;
- back navigation within a tab before leaving its root;
- no desktop bootstrap, loopback token, or WebSocket in mobile composition;
- no `Sidebar` or desktop window controls in the mobile accessibility tree; and
- an Android Settings grouped root and child route, with desktop System Proxy,
  Helper, startup, window, and installer controls omitted rather than inert;
- Android Settings baseline and portable mutations returning complete accepted
  Shared Rust `native` snapshots, with a failed mutation re-reading the last
  confirmed snapshot after recreation; and
- unavailable native capabilities never simulating success.

## Production-disabled native shell entry contract

Run:

```sh
cargo test -p mish-mobile-shell
node --test scripts/check-mobile-shell-boundary.test.ts
node scripts/check-mobile-shell-boundary.ts
```

These checks prove the closed Android/Apple chrome and validated platform-deep-
link model, exact Native-to-Rust-to-Web fixture, monotonic revision, bounded
duplicate/stale behavior, prepare/commit revalidation, invalid-input
non-mutation, and deterministic rejection of Web-to-Native UI backchannels.
They also prove that `apps/mobile` does not depend on the contract crate, so the
current React shell remains selected. This evidence permits only a
**production-disabled shell contract** claim. It is not a compiled Android or
Apple adapter, native rendering, device, accessibility, latency, or production
cutover claim. See
[`../architecture/mobile-native-shell-entry.md`](../architecture/mobile-native-shell-entry.md).

## Viewport and interaction matrix

At minimum, run real-browser mobile-shell coverage at:

| Context                  | Viewports                                                        |
| ------------------------ | ---------------------------------------------------------------- |
| Compact Android portrait | 320 x 568 and 360 x 800                                          |
| Common Android portrait  | 412 x 915                                                        |
| Compact iPhone portrait  | 375 x 667                                                        |
| Common iPhone portrait   | 390 x 844 and 430 x 932                                          |
| Landscape                | Representative compact and common Android/iPhone landscape sizes |

Run English and Simplified Chinese at every compact-width boundary. Checks
cover labels, safe areas, keyboard visibility, text scaling, local scroll
ownership, clipped controls, selected states, sheet focus restoration, and
reduced motion. Platform snapshots must not be used as the only behavioral
evidence.

For Android Settings, run the grouped root and at least the Application, VPN,
Network and DNS, and Recovery child routes through the same matrix. Verify that
the bottom navigation remains reachable, a child route returns to Settings with
the top-bar Back control, rows and segmented controls retain 44px touch targets,
and large text or a reduced keyboard viewport does not create horizontal
overflow or hide the final row.

## Android debug acceptance

The first Android device slice targets one supported ARM64 device and one x86_64
emulator where practical.

### Build and artifact

- `tauri android init` output is reproducible from committed project inputs.
- The debug APK includes the complete offline Web asset set.
- The correct native Core exists for every packaged ABI and no desktop Mihomo
  executable is present.
- The application reports the expected Mihomo commit, Go version, wrapper
  revision, and artifact checksum.
- The Manifest exposes only required permissions and protects the VPN service
  with the platform VPN binding permission.

### Native client

- Initial bind subscribes first, then accepts one complete Shared Rust baseline
  before replaying later same-authority events.
- Activity recreation and WebView reload rebind without starting or stopping
  the VPN unexpectedly.
- Lifecycle commands carry operation identity, are idempotent for the same
  command, reject conflicting or duplicate pending work, and return only a
  terminal or explicitly unknown outcome.
- A dropped binder or activity connection reconciles current service state
  before accepting later events.
- Prior-authority, retired-session, out-of-order, unknown, oversized, stale, or
  malformed native messages are rejected.

The retained Phase 0 fixture evidence predates the real VPN slice and remains
historical only. Current Android acceptance uses the native backend and must not
reuse a fixture `unavailable` result as device-VPN evidence. Shared Rust is the
only product lifecycle authority. Kotlin owns permission observations,
foreground-service effects, TUN/Core/network effects, Android callbacks, and
fact publication. Kotlin persists only minimum platform recovery evidence; it
does not persist or reconstruct product phase, message, authority/session,
revision, sequence, or complete snapshots.

Configuration loading carries only caller-owned fictional bytes plus bounded
operation, revision, digest, and current mobile session/sequence authority.
Input over the ABI limit, invalid digest, cancellation before or after the
native barrier, duplicate commands, stale or replaced authority, timeout,
Kotlin/JNI failure, every ABI status, and malformed or oversized native
envelopes resolve to closed bounded product results. A proven v1 rejection
preserves the prior healthy loaded identity; an unprovable outcome becomes
unknown. Native envelope contents, raw configuration, URLs, credentials, nodes,
tokens, and paths never enter results, logs, persistence, or fixture snapshots.

### VPN behavior

- Permission denial leaves the application stopped and actionable.
- Permission acceptance establishes the expected TUN and foreground
  notification before reporting healthy.
- `running` requires same-session foreground, validated underlying network,
  TUN, routes, DNS, Core, at least one protected socket, and a successful fixed
  public request; no partial subset may be projected as healthy.
- TCP, UDP, IPv4, IPv6 where supported, and DNS traverse the intended route.
- Core sockets are protected from recursive VPN capture.
- Rule, Global, and Direct modes remain truthful after switching.
- Policy-group selection is confirmed against current membership.
- Closing one or all active connections returns an authoritative result.

### Lifecycle and recovery

- The VPN remains correct with the WebView hidden, destroyed, or recreated.
- Screen lock and unlock do not publish a false healthy or stopped state.
- Wi-Fi-to-cellular, cellular-to-Wi-Fi, loss, and recovery transitions reconcile
  the active network and observation streams.
- `onRevoke`, service destruction, Core failure, and invalid configuration close
  owned descriptors and reach a safe typed state.
- Explicit stop removes foreground state, stops the Core, closes the TUN, and
  leaves no traffic capture behind.
- Cancellation and failed activation remain pending until that same cleanup is
  observed; a late start completion cannot restore Running.
- A representative 24-hour run remains within the agreed memory, wakeup, and
  battery budgets before Android beta.

## iOS preparation acceptance

The following work can proceed before paid capability and distribution access:

- generate and compile the iOS shell with the complete offline Web bundle;
- compile the Swift mobile plugin and Packet Tunnel extension source;
- build the pinned Core for device and simulator architectures and assemble the
  expected XCFramework structure;
- validate the closed provider-message schemas and App Group storage logic with
  deterministic tests;
- test main-app state reconciliation against a mock provider; and
- verify generated-project changes are intentional and survive the documented
  regeneration workflow.

These checks permit a `compiled shell` or `native fixture` claim only. They do
not prove a working Packet Tunnel.

## Deferred iOS device and TestFlight gates

When the required Apple account and capabilities are available, validation must
prove:

- main app and Packet Tunnel App IDs, App Group, Network Extension capability,
  and provisioning profiles match the intended release identity;
- the extension is embedded in the main app and preserves its declared
  entitlements after archive export;
- the selected tunnel-file-descriptor handoff works on every supported iOS
  release;
- TCP, UDP, DNS, IPv4, IPv6 where supported, and route exclusions behave on a
  physical device;
- lock, wake, network switch, extension memory pressure, provider restart, and
  main-app termination reconcile correctly;
- provider messaging stays bounded, redacted, versioned, and responsive;
- explicit stop and extension failure leave no claimed active tunnel; and
- the TestFlight artifact is inspected after export, not only inferred from the
  Xcode project.

An App Store release remains separately gated by organization enrollment,
privacy disclosures, applicable territory requirements, and review acceptance.

## Native Core verification

Every Android and Apple artifact check records:

- Mihomo source commit and release relationship;
- wrapper source revision;
- exact Go toolchain and build tags;
- target operating system and architecture;
- SHA-256;
- license notices and corresponding-source location;
- SBOM; and
- automated ABI compatibility results.

Android build evidence is host-specific. A CI package may use checksums created
by its current dual-pass build only when the verifier also matches the fixed
source manifest, current wrapper digest, exact current-host Go archive, NDK and
build contract, expected artifact paths, actual ELF machines and exported
symbols, and SBOM. Local staging defaults to the committed canonical evidence;
cross-host byte identity is not a release claim.

No release accepts a third-party prebuilt AAR, `.so`, static library, or
XCFramework without reproducible source inputs and independent digest
verification.

## CI matrix

The initial matrix separates jobs so one unavailable platform gate does not hide
another result:

1. shared Web, contract, and mobile-shell tests;
2. Android native fixture and debug APK build;
3. Android native Core per-ABI build and checksum verification;
4. iOS shell, Swift bridge, and extension compile check without a device claim;
5. Apple XCFramework architecture and checksum verification; and
6. credential-gated iOS archive, entitlement, and TestFlight checks when
   authorized.

Pull requests upload no distributable mobile package by default. Any debug
artifact policy must state its source revision, supported ABI, signing mode,
Core version, checksum, retention, and non-production status.

## Manual review

Before a device milestone, manually review:

- Android and iOS platform familiarity rather than cross-platform visual
  imitation;
- thumb reach, one-handed navigation, and keyboard obstruction;
- connection and Profile workflows with long Unicode labels;
- destructive and permission prompts in context;
- VoiceOver and TalkBack order and announcements;
- larger text, increased contrast, reduced motion, and reduced transparency;
  and
- truthful offline, permission-required, disconnected, failed, and recovery
  states.

## References

- [Android VPN service](../operations/android-vpn-service.md)
- [Mobile runtime integration](../architecture/mobile-runtime-integration.md)
- [Mobile navigation and layout](../design/mobile-navigation-and-layout.md)
- [Mobile runtime reference review](../research/mobile-runtime-reference-review-2026-07-20.md)
