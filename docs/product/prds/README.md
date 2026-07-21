# Product Requirement Documents

Status: 2026-07-18 planning baseline; approval was not recorded.

These documents preserve product intent, requirement IDs, priorities, and
acceptance language. They are not implementation status. For current behavior,
inspect code/tests and the architecture or quality contract linked by
[`../../README.md`](../../README.md).

## Product bet

Give people who keep Mish running all day a quiet, trustworthy workbench that
can import a profile, control traffic capture, make group-scoped route changes,
and explain network behavior without exposing Mihomo's configuration model by
default.

## Map

| Document | Owns |
| --- | --- |
| [00 — Product Suite](00-product-suite.md) | Users, principles, information architecture, release slices |
| [01 — Everyday Control](01-everyday-control.md) | Status and frequent capture/routing actions |
| [02 — Profiles and Routes](02-profiles-and-routes.md) | Import, activation, profile safety, and group-scoped routing |
| [03 — Traffic, Events, and Diagnostics](03-traffic-events-diagnostics.md) | Investigation, connection commands, events, and diagnostics |
| [04 — Settings and Native Integration](04-settings-native-integration.md) | Preferences, native capabilities, recovery, and platform rollout |
| [05 — Functional Inventory](05-functional-configuration-inventory.md) | Capability placement without copying competitor navigation |

## Stable conclusions

- Desktop uses Status, Routes, Profiles, Traffic, Events, and Settings. Mobile
  uses Home, Routes, Profiles, Activity, and Settings.
- Rule mode has no globally active node; choices are always `group -> child`.
- Privileged, destructive, or network-changing actions require explicit intent,
  visible progress, confirmation, and recoverable failure.
- Unsupported capabilities stay unavailable; mock data never proves native or
  network behavior.
- User labels are opaque Unicode. Do not infer geography or parse emoji.
- Core assets ship offline. Runtime network access is limited to user
  configuration, explicit probes, and explicit updates.
- Telemetry is off by default.

Priority labels retain their original planning meaning: P0 for the macOS alpha,
P1 for public macOS beta, and P2 for later desktop/mobile expansion. Actual
release readiness is decided by the target-specific quality documents, not by a
requirement's presence here.

## Evidence

The original requirements were derived from [`../../../PRODUCT.md`](../../../PRODUCT.md),
[`../../../DESIGN.md`](../../../DESIGN.md), the architecture contracts, and the
[Clash Verge Rev walkthrough](../../research/clash-verge-rev-deep-walkthrough-2026-07-18.md).
Competitor evidence is an inventory, never Mish's interaction authority.
