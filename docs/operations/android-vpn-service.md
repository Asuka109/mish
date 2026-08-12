# Android VPN Service

## Claim boundary

This runbook covers the first real Android `VpnService` vertical slice. It
establishes a platform-owned TUN, starts the pinned embedded Mobile Core, routes
device traffic through that Core, protects Core sockets from recursive capture,
and publishes `running` only after a fixed public request succeeds.

The slice does not deliver production Profile import, live Routes/Traffic/Event
commands, iOS tunneling, store signing, or release publication. The only
configuration inputs are the bounded, exact revision and digest already
validated and loaded through the Mobile Core contract. No path, Controller
endpoint, provider URL, or arbitrary native command crosses the activation
boundary.

## Ownership

- Shared Rust is the sole product lifecycle authority. It owns command and
  operation identity, product session, revision, sequence, cancellation, stale
  completion retirement, terminal outcome, and recovery policy.
- Kotlin owns Android permission, foreground-service lifetime, the TUN file
  descriptor, routes and DNS, underlying-network callbacks, socket protection,
  Core effects, and publication of observed platform facts.
- JNI exposes only the versioned Mobile Core ABI. The Go wrapper duplicates the
  supplied TUN descriptor before giving it to `sing-tun` and owns that duplicate
  until Core stop.
- React installs the snapshot listener before its baseline, projects accepted
  authority, and sends typed commands. Its `AbortSignal` invokes the typed
  lifecycle cancellation command; React never advances product phase locally.

## Running barrier

One product session can become `running` only when all of these facts are true
for that same session:

1. VPN consent remains granted and the service is foreground;
2. a validated non-VPN underlying network is observed;
3. the IPv4/IPv6 TUN and default routes are established;
4. the fixed platform DNS policy is applied;
5. the embedded Core reports the same session running;
6. at least one Core socket was successfully protected; and
7. `http://1.1.1.1/cdn-cgi/trace` returned an HTTP response in the fixed
   `200..399` range through the TUN/Core path.

Only the response category is retained as a boolean. Response bodies, headers,
destinations observed by Core, socket descriptors, configuration bytes,
authority identifiers, and native error text are not persisted or published as
acceptance evidence. Android Private DNS may probe the fixed `1.1.1.1` resolver
over TLS; Mish records only that the DNS policy was applied, while the separate
numeric public probe proves routed egress without depending on resolver warmup.

## Network policy

The platform TUN uses `172.19.0.1/30` and
`fdfe:dcba:9876::1/126`, MTU 1500, and IPv4/IPv6 default routes. Android is
given the fixed IPv4 resolver `1.1.1.1`; the Core hijacks its port 53 traffic.
The underlying-network set contains only non-VPN networks with `INTERNET` and
`VALIDATED`. Stale `Network` objects are rechecked before use.

Loss of every usable underlying network clears the public-request fact and
publishes `unavailable` while the foreground TUN/Core session remains owned.
Recovery updates the TUN underlying-network set, repeats the public probe, and
returns to `running` only after the complete barrier is true again.

## Stop, failure, and recovery

Cleanup is ordered Core -> TUN -> network callback and is idempotent for one
service instance. Stop and failed activation clear only Mish-owned resources.
An incomplete cleanup keeps recovery evidence and never publishes a clean
terminal state.

Cancellation sets a service-local stop flag before its serialized cleanup task
is queued, so network and public-probe waits can exit without publishing a late
Running or unrelated failure. Shared Rust keeps the consequential operation
pending until the cleanup completion fact arrives.

`onRevoke`, Core exit, service destruction, process replacement, duplicate or
reordered facts, and stale completions have closed typed transitions. A process
replacement with a persisted foreground-expected record starts as
`recovery-required`; it never replays activation. **Clean Up VPN** performs an
idempotent stop and removes the recovery record only after cleanup is observed.

## Kotlin authority admission and retryable cleanup

The Tauri adapter and `MishVpnService` admit the complete Rust lifecycle
authority before enqueuing `startForegroundService`, promoting the foreground
notification, establishing a TUN, starting Core, or persisting activation
facts. An exact retry is idempotent; only the Rust-defined successor authority
may advance the persisted record. Malformed, foreign, or stale intents are
ignored without cleaning the current owner.

Cleanup tracks Core, TUN, and network callback ownership independently. A
partial result is published as foreground-expected recovery evidence and keeps
the authority plus failed resource owned. Later stop/recreation cleanup retries
only the failed resources; `STOP_COMPLETED`/clean facts are published only
after every owned resource releases successfully. This is a closed semantic
JVM contract and does not claim emulator or physical-device behavior.

## Local verification

Build and contract checks:

```sh
pnpm mobile-core:contract
pnpm mobile-core:verify
pnpm mobile:android:test
pnpm mobile:android:build
pnpm check:android
```

The Android build produces separate ARM64 and x86_64 debug APKs. Generated Core
libraries and APKs remain ignored build outputs; committed evidence contains
only the pinned inputs, checksums, provenance, symbols, notices, and SBOM.

Device acceptance must use one explicit target and the Appium workflow in
[`mobile-validation.md`](../quality/mobile-validation.md). Record only bounded
facts for start, background/foreground, Activity recreation, cancellation,
network loss/recovery, process recovery, and stop. Physical ARM64 and x86_64
emulator results are separate required gates; a cross-compiled ABI or an ARM64
emulator cannot substitute for either runtime result.

## Desktop non-interference

This service and plugin are Android-only. They do not call or modify the desktop
System Proxy adapter, the macOS Internal TUN helper, its recovery journal, or
desktop loopback RPC behavior.
