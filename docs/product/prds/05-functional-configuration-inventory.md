# PRD 05: Functional and Configuration Inventory

## Metadata

- Status: Draft for product review
- Implementation status: Not authoritative; see [PRD suite](README.md)
- Version: 0.1
- Date: 2026-07-18
- Parent: [PRD suite](README.md)
- Destinations: Status, Routes, Profiles, Traffic, Events, and Settings

## Purpose

This document converts competitor research and a profile-backed Clash Verge Rev
walkthrough into a Mihomo core capability inventory. It does not adopt Clash Verge
Rev's navigation, page composition, or control styling. Every capability below
must be expressed through this project's existing six-destination workbench,
object ownership rules, progressive disclosure, and shared command model.

The inventory answers two separate questions:

1. Which runtime functions and configuration fields must the product understand?
2. Where does each function belong in our interaction model?

## Configuration model

The product shall not treat one imported YAML document as both user policy and
desktop application state. The effective configuration has explicit layers:

1. **Immutable source**: the fetched or selected local profile as received.
2. **Profile-scoped patches**: user-owned proxy, group, rule, and safe override
   changes that can be inspected and removed independently.
3. **Application policy**: pinned core compatibility, ports, controller
   transport, logging, privacy, update, and resource policy.
4. **Platform integration**: System Proxy, TUN/helper, interfaces, route and DNS
   integration, startup, tray, and permissions.
5. **Effective runtime**: the validated, generated Mihomo configuration with
   provenance and redaction.

Import preflight must classify conflicts such as device-specific filesystem
paths, listener addresses, TUN enablement, controller credentials, and ports.
The user sees what will be preserved, overridden, disabled, or rejected before
activation. Importing a router configuration must never silently enable desktop
traffic capture.

## Capability inventory and product placement

| Capability | Configuration or runtime scope | Product destination and pattern | Release decision |
| --- | --- | --- | --- |
| Local and remote profile sources | File, HTTPS URL, label, description, source provenance | Profiles: source-first import with validation preview | P0 |
| Remote fetch policy | User agent, timeout, interval, auto-update, TLS validation, direct/System Proxy/core-proxy fetch route | Profiles: Advanced fetch policy attached to one source | P1 |
| Profile lifecycle | Validate, activate, reactivate, update, last-known-good rollback, delete, reorder, bounded batch actions | Profiles: explicit commands with pending/result state | P0 lifecycle; P1 scheduling and batch |
| Portable configuration preflight | Counts, unsupported keys, absolute paths, listener conflicts, capture settings, secrets | Profiles: review step before first activation | P0 |
| Effective runtime inspector | Final YAML plus source, patch, app, and platform provenance | Profiles summary and Events diagnostics: read-only, redacted inspector | P1 |
| Structured source patches | Common groups and rules; ordered prefix/suffix insertion; no P1 raw fallback | Profiles: object-specific patch editors, never silent source rewriting | P1 common rules/groups; later proxy protocol authoring |
| Merge and script transforms | Global or profile-scoped YAML merge and JavaScript transform | Profiles: expert transformation pipeline with preview and rollback | Later |
| Policy-group tree | Selector and core-supported strategy groups, nested children, current selection, hidden groups | Routes: expandable group-owned tree | P0 |
| Group tools | Current child, configuration/latency/name sorting, text filter, node detail toggle, group-scoped fixed delay policy | Routes: group-local toolbar, not a page-global toolbar | P0 filter/sort/test; P1 custom probe policy |
| Node capability detail | Protocol family, UDP/XUDP support, health result, last test time | Routes: secondary metadata on a child | P0 supported capabilities; P1 richer health history |
| Routing mode | Rule, Global, Direct | Status command with Routes explanation; never styled as navigation | P0 |
| Chained outbound | Ordered nodes, policy-group context, minimum-length validation, performance warning, connect/disconnect | Routes: dedicated expert workflow with preview and rollback | P2 |
| Rule inspection | Ordered effective rules, type, payload, target, priority, search | Traffic: Rules subview | P0 |
| Rule providers | Provider name, source type, behavior, record count, last update, update one/all, typed failure | Profiles owns source lifecycle; Traffic links to effective contents | P1 |
| Active connections | Destination, process when available, network/protocol, age, current and total bytes, rule, ordered route chain | Traffic: active table and expandable detail | P0 |
| Closed connections | Bounded recent history, clear local history, filtering and upload/download sorting | Traffic: Closed tab with explicit retention | P0 bounded history |
| Connection commands | Close one and close all with unambiguous scope | Traffic: row and collection commands | P0 |
| Runtime events | Timestamp, level, source, message, structured detail, pause, order, clear local view, severity/text filters | Events: unified event stream | P0 |
| Endpoint and service probes | Pending/running/result, support or reachability state, route, region when relevant, timestamp | Events: user-managed diagnostics, neutrally named | P1 |
| Status summary | Active profile, capture, mode, frequent groups, traffic totals, memory, core version, rule count | Status: compact single-screen workbench | P0 |
| System Proxy | Desired state, observed OS state, address, PAC, guard, bypass and validation | Settings owns configuration; Status owns command and drift | P0 basic; P1 PAC/guard |
| TUN and helper | Availability, stack, device, auto/strict route, interface detection, DNS hijack, MTU, exclusions | Settings: capability-gated subsystem; Status owns command | P1 macOS beta |
| DNS | Enablement, listen, enhanced mode, fake-IP range/filter, IPv6/HTTP3, hosts, resolvers, policies, fallback | Settings: basic summary plus expert subpage and validation | P1 |
| Network interfaces | Names, addresses, MAC when allowed, active/default indication, copy | Settings: read-only platform inventory | P1 |
| Local controller and Web UI | Loopback listener, authentication, allowed origins, dashboard templates | Settings: secure local-control section | P1; no LAN exposure by default |
| Local tunnels | Protocol, local/target endpoints, optional group/child pinning | Settings: reusable forwarding objects | P2 |
| Core lifecycle | Pinned stable/preview channel, restart, upgrade, compatibility report | Settings and Events recovery | P1 |
| Desktop shell | Startup, tray commands, hotkeys, lightweight mode, appearance, navigation density | Settings: platform-scoped sections using shared commands | P1 |
| Backup and recovery | Local backup, optional WebDAV, history, import/restore, transform-triggered backup | Settings: Diagnostics and Recovery | P1 local; P2 remote |
| Diagnostics export | Versions, capability state, bounded events, profile fingerprint, checks, redaction preview | Events: Diagnostics and Recovery | P1 |

## Implemented P1 lifecycle slice

The implemented provider slice covers both proxy and rule providers from the
current pinned runtime. It exposes only safe aggregate metadata, requires exact
profile/runtime authority for update commands, re-observes after mutation, and
keeps partial failure typed. It does not expose provider URLs, paths, payloads,
proxy endpoints, or credentials. Profile-source scheduling remains a separate
Profiles lifecycle with fixed opt-in intervals and persisted backoff.

## Requirements

| ID | Priority | Requirement | Acceptance criteria |
| --- | --- | --- | --- |
| INV-F-001 | P0 | Import shall separate portable profile policy from application and platform settings. | Given a profile contains ports, controllers, filesystem paths, or enabled capture settings, the review identifies each conflict and activation cannot silently apply desktop network capture. |
| INV-F-002 | P0 | Every generated runtime value shall have a configuration-layer provenance. | Given the effective runtime differs from the source, the inspector identifies the owning layer and whether the value was preserved, patched, overridden, or rejected. |
| INV-F-003 | P0 | Activation shall validate the complete generated artifact and commit it transactionally. | Given generation or core activation fails, the prior healthy runtime remains active or the product reaches a documented safe stopped state. |
| INV-F-004 | P0 | Unknown but syntactically valid Mihomo keys shall not be silently discarded. | Import reports preservation support; any rewrite that cannot round-trip a key requires an explicit warning and retains the immutable source. |
| INV-F-005 | P1 | Structured editors shall create inspectable patches instead of mutating a remote source snapshot in place. | A user can review, disable, reorder, or remove a patch and regenerate the original source-derived runtime. |
| INV-F-006 | P0 | Sensitive configuration and runtime values shall remain local and redacted by default. | Screenshots, events, clipboard actions, diagnostics, and repository artifacts exclude credentials, subscription URLs, private endpoints, node labels when sensitive, and raw configuration secrets. |
| INV-F-007 | P0 | Feature availability shall be capability-driven. | Given the pinned core or platform lacks a field or command, the UI omits or disables it with an explanation and never simulates success. |
| INV-F-008 | P0 | Competitive capability coverage shall not change the approved information architecture. | Every implemented item in this inventory has one owning destination and reuses the shared command/state pattern instead of introducing a competitor-shaped primary page. |

## Interaction decisions

- A mode switch is a consequential command, not a tab.
- A selected child always belongs to a named group; Rule mode has no invented
  globally active node.
- Provider update, latency test, endpoint probe, core restart, and profile
  activation expose scope, progress, timestamp, and typed failure.
- Source editing, patches, app policy, platform integration, and final runtime
  are visually distinct even when all are represented as YAML internally.
- Dense expert forms use summaries, sections, and validation. Raw fallback is
  not part of the P1 structured-patch surface.
- Private competitor references and live configuration files remain outside
  version control. Product documents record only generalized observations.

## Remaining evidence gaps

- Proxy-provider card behavior and provider-backed node failures.
- URL-test, fallback, load-balance, and relay groups with populated high-volume
  datasets.
- Profile refresh failure, last-known-good rollback, and schedule backoff.
- Status-bar menu contents, because the Computer Use target could not access
  the macOS status item.
- Cross-platform differences for Windows service mode, Linux desktop proxy
  integration, Android VPN service, and iOS packet tunnel behavior.
