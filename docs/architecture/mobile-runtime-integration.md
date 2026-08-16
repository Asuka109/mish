# React Native Runtime Boundary

React Native is a host seam for the shared TypeScript product. The mobile app
imports shared contracts, oRPC session composition, XState actors, Query, and
presentation components. It does not provide a second product lifecycle or a
compatibility client.

## Android admission

The owned Android gate runs type checks and tests, builds a debug APK for
`arm64-v8a` and `x86_64`, then uses a root-free emulator replay. The replay is
credential-free and requires `RN_ADMISSION_OK`. The harness records bounded
process and serial cleanup and rejects residual processes, ports, mounts, or
build outputs.

## Native seam

Only an explicitly required Kotlin/Swift/Objective-C effect seam may live in
the host. It returns typed results to the shared actor and records a sanitized
transcript. Product lifecycle, cache authority, and business state stay in
TypeScript. A missing seam is represented as a typed unavailable result, never
as a simulated legacy API.

## Evidence limits

The Android gate does not grant real permissions, start a VPN, attach a TUN,
open a serial device, or claim external network behavior. Those effects remain
outside automated acceptance.

The former native-shell direction tracked by Issue #373 was superseded and is
not a current implementation authority.
