# Product Requirement Documents

## Status

- Status: Draft for product review
- Version: 0.1
- Date: 2026-07-18
- Product owner: Project owner

This suite turns the current product, design, architecture, prototype, competitor
screenshots, and hands-on Clash Verge Rev review into an implementation contract.
The documents describe observable product behavior. Existing architecture and
design documents remain authoritative for implementation boundaries and visual
tokens.

## Product bet

For people who keep Mish running throughout the day, provide a quiet,
trustworthy workbench that can import a usable profile, control traffic capture,
make group-scoped route changes, and explain current network behavior without
requiring the user to understand the Mihomo core's internal configuration model.

The bet succeeds when a user with a valid profile can reach a healthy proxied
state quickly, can tell what the client is doing, and can recover from common
failures without opening a terminal or a second administration dashboard.

## PRD map

| Document | Product question | Main destinations |
| --- | --- | --- |
| [00 — Product Suite](00-product-suite.md) | What product are we building, for whom, and in which release order? | Whole product |
| [01 — Everyday Control](01-everyday-control.md) | How does a user start, stop, inspect, and make frequent changes? | Status |
| [02 — Profiles and Routes](02-profiles-and-routes.md) | How does configuration become a safe, selectable routing model? | Profiles, Routes |
| [03 — Traffic, Events, and Diagnostics](03-traffic-events-diagnostics.md) | How does the user inspect behavior and investigate failures? | Traffic, Events |
| [04 — Settings and Native Integration](04-settings-native-integration.md) | How do platform capabilities and advanced preferences remain safe? | Settings, tray, native shell |
| [05 — Functional and Configuration Inventory](05-functional-configuration-inventory.md) | Which Mihomo core capabilities and configuration layers must the product cover, and where do they belong in our interaction model? | Whole product |

## Confirmed evidence

| Source | What it establishes |
| --- | --- |
| [Deep Clash Verge Rev 2.5.1 walkthrough](../../research/clash-verge-rev-deep-walkthrough-2026-07-18.md) | A Computer Use coverage matrix across all primary pages, safe secondary surfaces, dropdown inventories, top/middle/bottom scroll evidence, and a profile-backed follow-up of previously blocked runtime surfaces |
| Local private competitor reference set | Stash desktop/mobile and Shadowrocket mobile information architecture and configuration density; the source files are intentionally excluded from version control |
| [`PRODUCT.md`](../../../PRODUCT.md) | Users, purpose, personality, anti-references, and product principles |
| [`DESIGN.md`](../../../DESIGN.md) | Cal-derived design system and macOS utility composition |
| [`status-experience.md`](../status-experience.md) | Approved Status behavior and semantics |
| [`frontend-platform-boundary.md`](../../architecture/frontend-platform-boundary.md) | Shared web product layer, desktop bridge, RPC, Tauri, and privileged-helper ownership |
| [`status-data-contracts.md`](../../architecture/status-data-contracts.md) | Mihomo core source mapping, group-usage derivation, and service-probe semantics |

## Competitive conclusions

1. Clash Verge Rev demonstrates broad feature completeness, but its customizable
   Home card stack, separate Rules/Logs/Tests destinations, and long Settings
   page with workspace-sized dialogs create repeated state and fragmented
   investigation flows.
2. Stash is strongest when it treats the desktop app as a stable workbench and
   mirrors group-scoped actions in a native status menu. Its HTTP rewrite and
   MitM surfaces are expert products of their own, not requirements for this
   client's first releases.
3. Shadowrocket is an effective mobile configuration tool, but its dense node
   forms and broad protocol catalog should not define the default desktop
   experience.
4. The project should keep six stable desktop destinations: **Status, Routes,
   Profiles, Traffic, Events, and Settings**. Mobile may map the same jobs into
   four bottom tabs with secondary destinations nested inside them.
5. Rule mode has no canonical globally active node. Every shortcut and native
   menu selection must preserve the hierarchy `policy group -> child`.
6. DNS, TUN, backup, runtime configuration, and interface inspection are too
   substantial to be treated as undifferentiated modal forms. They need clear
   basic summaries, dedicated expert detail, and observable effective state.

Competitive evidence is a capability inventory, not an interaction template.
The project continues to use its six-destination workbench, object ownership,
progressive disclosure, and command patterns even when it implements a feature
also present in Clash Verge Rev, Stash, or Shadowrocket.

## Evidence limitations

The profile-backed follow-up closed the major gaps for populated selector
groups, profile-item menus, connection detail and history, ordered rules, one
HTTP rule provider, live logs, and an unlock-test result. Proxy-provider cards,
non-selector group behavior under load, update failures, and the macOS
status-bar item remain unobserved. Private source files, configuration values,
node labels, endpoints, and network identity were not copied into these docs.

## Shared requirement conventions

- `P0`: required for the macOS end-to-end alpha.
- `P1`: required for the public macOS beta.
- `P2`: later desktop or mobile expansion.
- User-authored labels are opaque Unicode strings and must be rendered verbatim.
- Destructive, privileged, or network-changing actions require explicit user
  intent, visible progress, and a recoverable failure state.
- Core pages must work offline after installation. Runtime network calls are
  limited to the user's configuration, explicit probes, and update checks.
- Telemetry is off by default. Product success is evaluated with opt-in studies,
  local QA fixtures, support evidence, and explicitly consented diagnostics.

## Approval boundary

These PRDs are ready for product review, not yet approved for implementation.
Approval should confirm the proposed release slices, the six-destination
information architecture, and the open questions in the module documents. The
next step after approval is to convert `P0` requirements into vertical-slice
issues with requirement-to-test traceability.
