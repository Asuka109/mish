# Android VPN lifecycle transcripts

## Claim

This gate proves that the existing Android VPN lifecycle authorities compose
across JavaScript delivery, the authenticated Tauri plugin boundary, Shared
Rust reduction, Kotlin admission and owned-resource cleanup, durable Android
recovery evidence, and JavaScript projection. It does not add another
lifecycle owner: every state transition is still decided by the production
Shared Rust reducer or the production Kotlin admission, store, and cleanup
contracts.

The emulator harness owns only Android process/component recreation,
`SharedPreferences` persistence, closed effect injection, and observation. It
never starts `MishVpnService`, requests VPN consent, creates a TUN, loads Core,
opens a socket, changes a route or DNS setting, or sends network traffic.

## Boundary matrix

| Layer             | Production authority retained                                                                                                   | Replaced or controlled seam                                            | Bounded evidence                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| React/JavaScript  | `MobileVpnFixtureClient` generation, authority, session, revision, sequence, and Zod contracts                                  | Typed `invoke`/`listen` transport only                                 | Baseline race, reconnect/remount, replacement, stale/equal/duplicate delivery, cancellation, and 32-event overflow rejection                      |
| Tauri/Shared Rust | Real VPN reducer, state-machine runner correlation, effect identity, cleanup barrier, final outcome, and observation projection | Closed `simulated-host` platform effect/result adapter                 | Versioned events for command, result, callback, replacement, retirement, cleanup retry, finalizer, recreation, and admission rejection            |
| Kotlin            | Real `CoreLifecycleAuthority`, `MishVpnPlatformStore`, `MobileCoreAdmissionGate`, and `MishVpnOwnedResourceCleanup`             | Closed lambdas for Core/TUN/network cleanup results; no Android effect | Persist-before-effect, exact retry, successor replacement, stale retirement, recreation, retryable cleanup, and admission rejection before effect |
| Android emulator  | Real Android instrumentation process, application context, `SharedPreferences`, plugin classes, and Gradle test APK             | Store/component re-instantiation and the same closed cleanup lambdas   | Authority recovery in a new store instance, clean-record removal, strict transcript parsing, and effect counters                                  |
| CI/build policy   | Reviewed workflow, pinned SDK/NDK/emulator/action inputs, and production package graph                                          | Credential-free PR test runner                                         | Root-free x86_64 emulator gate plus source/dependency production-exclusion checks                                                                 |

The JavaScript mock and emulator fixture cannot return a canned lifecycle
success. JavaScript only delivers typed snapshots produced by its transport;
the Rust fixture drives the real reducer; and the emulator calls the real
Kotlin contracts, recording only their accepted or rejected result.

## Named deterministic cases

The bounded matrix covers:

- `replacement`: only the Rust-defined successor replaces authority; a late
  completion from the retired owner cannot replace truth;
- `cancellation`: cancellation remains pending until the owned cleanup effect
  and matching platform observation both complete;
- `failure-cleanup-retry`: a failed owned resource remains retryable and only
  that resource is retried before clean publication;
- `finalizer-barrier`: effect completion cannot publish a terminal result
  before the matching cleanup callback/observation;
- `recreation-cleanup-retry`: a new Android store instance reads the complete
  persisted authority, rejects stale delivery, retries remaining cleanup, and
  removes recovery evidence only after clean completion;
- `remount-reconnect`: a new JavaScript generation accepts one authoritative
  baseline and retires prior-generation delivery;
- `stale-equal-duplicate`: strict sequence/revision/authority checks accept an
  exact retry only where the owning contract defines idempotence and reject or
  retire conflicting delivery; and
- `admission-rejected`: a relevant Mobile Core admission failure returns before
  the effect closure is invoked.

Tests use event order as logical time. They use no wall-clock sleep, timeout,
host networking, root access, credential, or external service to determine a
lifecycle result.

## Transcript and privacy schema

Rust transcripts use schema version 2 and at most 32 events. Each event carries
only closed synthetic authority/runtime/operation/effect identities, safe
positive integer revisions and epochs, logical time, and enum effect/result
kinds. Serde rejects unknown fields, invalid versions, zero identities, empty
events, and overflow.

The Android instrumentation transcript has the same 32-event bound and logical
time rule. Its scenario, effect, and result fields are closed enums/sets; every
object rejects unknown fields; and authority values must remain positive safe
integers. JavaScript trace delivery also fails closed at 32 events and parses
native envelopes through strict schemas before recording them.

There is no field for configuration bytes, profile/provider contents, URL,
host, path, credential, token, socket descriptor, packet, raw native output,
or arbitrary observation. Structural tests keep emulator-only transcript names,
scenario identities, and Android test dependencies out of product source and
APK inputs.

## Commands

Run the focused contracts with:

```sh
pnpm --filter @mish/web exec vitest run src/platform/mobile-vpn-client.test.ts
cargo test -p mish-simulated-host --all-features android_vpn -- --test-threads=1
pnpm mobile:android:test
node --test scripts/simulated-host-exclusion.test.ts
```

With one repository-supported API 36 ARM64 or x86_64 emulator already running, run:

```sh
pnpm mobile:android:test:emulator
```

Pull requests run the same instrumentation task in `Android lifecycle emulator
gate` on the root-free `macos-15-intel` GitHub-hosted runner. The workflow pins
API 36, Build Tools 36.1.0, NDK 29.0.14206865, emulator build 15917651, and the
repository-owned bounded boot/run/cleanup contract. The workflow uses no
third-party emulator action and rejects an unexpected emulator build before it
creates the test AVD. The exact Google Android emulator archive is additionally
bound to its reviewed SHA-256 before extraction into runner-temporary storage,
and the API 36 Google APIs x86_64 system image must resolve to revision 7. The
emulator runs without VM acceleration because GitHub-hosted macOS runners do not
expose nested virtualization; the instrumentation remains closed to Kotlin
authority/store/cleanup seams and does not load a real Core, VPN, or TUN.

## Evidence limits

Passing evidence proves deterministic Shared Rust/Kotlin/JavaScript authority
semantics plus JVM compilation/tests and execution inside one Android emulator
process, including persistent-store re-instantiation/component bootstrap. It
does not prove:

- physical-device behavior or installation through `PackageManager`;
- an actual process-death/relaunch or Android Activity recreation cycle;
- VPN permission or notification UI;
- a real foreground `VpnService` lifetime;
- real TUN creation, descriptor ownership, socket protection, or Mobile Core;
- packet flow, routing, DNS, underlying-network observation, or propagation;
- release signing, store packaging, deployment, or device power behavior.

Those remain physical-device, real-network, packaging, and release acceptance
work. Emulator evidence must never be cited as a device VPN result.
