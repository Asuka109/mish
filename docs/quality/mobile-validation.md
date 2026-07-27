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
- unavailable native capabilities never simulating success.

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

- Initial bind returns one complete validated snapshot.
- Activity recreation and WebView reload rebind without starting or stopping
  the VPN unexpectedly.
- Commands are idempotent and duplicate pending submission is rejected.
- A dropped binder or activity connection reconciles current service state
  before accepting later events.
- Unknown, oversized, stale, or malformed native messages are rejected.

For the Phase 0 fixture, the same lifecycle checks apply with one stricter claim
boundary: consent, foreground notification, serialization, reconstruction, and
recovery may be exercised, but every start must finish `unavailable` with
`vpnActive=false`. A separately staged Core may report verified package identity
as available. The bounded configuration-validation slice may initialize that
Core and call `mish_core_validate_config_v1`, but it never loads configuration,
starts Core, supplies a TUN descriptor, or changes VPN state. No fixture result
satisfies any item in the VPN behavior subsection below.

Configuration validation carries only caller-owned fictional bytes and current
mobile session/sequence authority. Input over the ABI limit, cancellation,
duplicate commands, stale authority, plugin/JNI failure, every ABI status, and
malformed or oversized native envelopes resolve to closed bounded product
results. Native envelope contents, raw configuration, URLs, credentials, nodes,
tokens, and paths never enter results, logs, persistence, or fixture snapshots.

### VPN behavior

- Permission denial leaves the application stopped and actionable.
- Permission acceptance establishes the expected TUN and foreground
  notification before reporting healthy.
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

- [Mobile runtime integration](../architecture/mobile-runtime-integration.md)
- [Mobile navigation and layout](../design/mobile-navigation-and-layout.md)
- [Mobile runtime reference review](../research/mobile-runtime-reference-review-2026-07-20.md)
