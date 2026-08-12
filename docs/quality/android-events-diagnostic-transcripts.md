# Android Events and diagnostic transcripts

## Evidence claim

This packet proves bounded Android Events publication and one cancellable fixed
diagnostic through deterministic Shared Rust, strict TypeScript wire parsing,
fake-native Kotlin effects, and repository-owned Android emulator
instrumentation. It does not prove physical-device behavior, a real VPN/TUN,
Mobile Core packet flow, real network reachability, deployment, or release
packaging.

## Boundary and transcript matrix

| Effect                           | Closed return                             | Owner                                         | Recording and deterministic case                                                                            | Privacy and limit                                                                                             |
| -------------------------------- | ----------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Observe lifecycle baseline/fact  | accepted, stale, gap/rebind               | Shared Rust Events authority                  | Rust Events tests plus existing lifecycle transcript; initial bind, order, gap, bounded history             | Evidence text is compiled and bounded; no native/JNI text; simulated facts do not prove real service behavior |
| Fetch Events/diagnostic baseline | strict snapshot                           | Shared Rust, projected by Tauri               | TypeScript fake transport; listen-before-baseline, recreation, gap fetch, replacement, retired late message | Zod rejects unknown fields and overflow; no desktop socket or endpoint                                        |
| Run fixed diagnostic             | completed, failed, timed-out, cancelled   | Shared Rust run authority; Kotlin effect only | Kotlin fake transport and emulator `fixed-diagnostic-demo` transcript                                       | Fixed target/timeout are not transcript fields; no real request occurs in tests                               |
| Cancel diagnostic                | accepted/rejected by operation and run ID | Shared Rust                                   | Rust replacement/late-completion tests; Kotlin JVM and emulator matching/nonmatching cancel                 | No raw failure; cancellation evidence cannot prove platform socket interruption timing                        |
| Replace runtime                  | replaced/runtime-replaced, joined         | Shared Rust                                   | Rust terminal/history assertions and TypeScript retired-authority delivery                                  | Old completion has zero product mutation; does not simulate OS process death                                  |

The emulator transcript remains schema version 2, bounded to 32 closed events,
and uses logical event order. The fixed diagnostic scenario records only
synthetic authority revision/effect identity, effect kind, and result kind. It
injects a Kotlin transport result and performs no DNS, socket, HTTP, VPN,
permission, TUN, route, or Mobile Core effect.

## Deterministic cases

- order and complete initial/recreation baselines;
- explicit sequence-gap recovery;
- cancellation and fixed timeout classification;
- runtime replacement and zero-mutation late completion;
- 1,024 Events, four checks, eight runs, and 32 transcript bounds;
- strict redaction/unknown-field rejection;
- view-local filter, pause, order, follow, and clear reset on replacement; and
- a fixed-probe emulator demo using the fake-native Kotlin seam.

Run focused evidence with:

```sh
cargo test -p tauri-plugin-mish-vpn --no-default-features --features simulated-host
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @mish/web exec vitest run src/platform/mobile-events-client.test.ts src/data/events-provider.test.tsx src/pages/events-page.test.tsx
pnpm mobile:android:test
pnpm mobile:android:test:emulator
node --test scripts/android-events-diagnostic-exclusion.test.ts
```

The emulator command requires one repository-supported emulator. Its passing
result is Android instrumentation evidence only and must not be cited as a
physical-device or real-network result.
