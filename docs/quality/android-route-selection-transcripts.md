# Android Route selection transcripts

## Claim

This gate proves one bounded Android policy-group selection through the mobile
Tauri plugin, Shared Rust Profile/Runtime authority, Kotlin/JNI adapter, and the
embedded Mobile Core command ABI. Shared Rust validates the committed Profile
identity and revision, current runtime authority, group membership, current
child, and target child before the native effect. A successful effect returns a
complete ordered Status/Routes snapshot; exact duplicate operations are
idempotent, while conflicting, cancelled, replaced, malformed, or delayed stale
operations do not add a mutation.

Desktop RPC and desktop Routes remain unchanged. Mobile does not use the
desktop loopback bridge. Kotlin and JNI own only bounded request/response
mapping, one typed Mobile Core call, and exact native buffer release. They do
not own product route identifiers, membership, selection state, or ordering.

## Deterministic evidence

| Layer               | Retained production authority                                                                                               | Closed test seam                                        | Evidence                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Shared Rust         | Config-derived Profile route catalog, stable IDs, runtime authority/epoch, operation admission, projection order, redaction | Bounded synthetic native result                         | Success, duplicate conflict, invalid relation, cancellation-before-effect, replacement, malformed ordering, redaction       |
| Mobile Core wrapper | Current lifecycle authority, selector current child, mutation, recent operation identity                                    | Parsed in-memory configuration; no TUN start or network | Success, duplicate no-op, reused-ID conflict, stale authority, authoritative Routes snapshot                                |
| C fake-native       | ABI command/status/routes envelopes and explicit buffer release contract                                                    | One fictional selector with `Alpha` and `Beta`          | Success, duplicate, conflict, stale authority, ordered snapshot                                                             |
| Kotlin/JNI          | Typed field mapping, strict envelope parsing, response limits, native buffer lifetime                                       | `MobileCoreRoutes` fake                                 | Stable IDs plus resolved labels, malformed response, native rejection, no adapter-owned state                               |
| Tauri/TypeScript    | Least-privilege commands, complete authority envelope, application-order acceptance                                         | Typed invoke transport                                  | Baseline, success, post-config baseline refresh, abort-before-effect, replacement, delayed stale result, malformed envelope |
| SimulatedHost       | Production transcript schema and production feature boundary                                                                | Closed logical-time model                               | Nine scenarios, zero-mutation failures, full recreation baseline, unknown/overflow rejection                                |
| Android emulator    | Real Android test APK and production Kotlin adapter classes                                                                 | In-memory fake native effect only                       | Success, duplicate, invalid relation, replacement, delayed stale command, component-style baseline reacquisition            |

The transcript schema is versioned and bounded to 16 events. Events contain
only synthetic numeric operation, runtime, and Profile-revision identities,
logical time, mutation count, snapshot order, and closed result enums. Unknown
fields, overflow, invalid identities, and non-monotonic logical time fail
closed. There is no field for configuration bytes, host, URL, path, provider,
credential, token, native output, socket, descriptor, packet, or arbitrary
text.

Android Rust serializes configuration load/publication and Route snapshot/effect
calls through one process-wide gate. This prevents a command admitted for the
old committed Profile from reaching a replacement Core. After a successful
configuration commit, the Web mobile bootstrap requests and publishes a fresh
full Routes baseline; an earlier unloaded baseline failure therefore does not
require a WebView reload.

## Commands

Run the focused repository evidence with:

```sh
cargo test -p tauri-plugin-mish-vpn mobile_routes
cargo test -p mish-simulated-host --all-features android_routes -- --test-threads=1
(cd mobile-core/wrapper && go test ./...)
pnpm mobile-core:contract
pnpm mobile:android:test
pnpm --filter @mish/web exec vitest run src/platform/mobile-status-client.test.ts
node --test scripts/check-mobile-capability-boundary.test.ts scripts/simulated-host-exclusion.test.ts
```

With one repository-supported emulator already running:

```sh
pnpm mobile:android:test:emulator
```

## Evidence limits

Passing evidence proves repository-owned deterministic Rust, Go, C
fake-native, Kotlin/JNI, Tauri, TypeScript, transcript, exclusion, and automated
emulator semantics. The emulator scenario does not load Mobile Core or start a
VPN service; it invokes the real Kotlin adapter against a closed in-memory fake.

It does not prove physical-device behavior, actual Activity/process death,
real VPN permission UI, foreground service lifetime, Core/TUN activation,
socket protection, packet flow, routing, DNS, external network behavior,
release packaging, signing, deployment, or downstream feature readiness.
