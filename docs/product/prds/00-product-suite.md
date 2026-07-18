# PRD 00: Mish Product Suite

## Metadata

- Status: Draft for product review
- Version: 0.1
- Date: 2026-07-18
- Parent: [PRD suite](README.md)

## Product bet

For desktop users who continuously run a rule-based local proxy, solve the
uncertainty of whether traffic is captured, where a policy group currently
points, and why a request failed with a compact native-feeling workbench. Measure
success by time to first healthy connection, task completion for frequent route
changes, and successful recovery from common failures.

## Users and triggering scenarios

### Primary user: daily operator

- Imports one or more remote or local profiles.
- Starts and stops capture, changes mode, and occasionally switches a group.
- Wants the app to remain quiet in the status bar when no action is needed.
- Needs plain-language health and recovery feedback rather than core internals.

### Secondary user: network power user

- Inspects connections, matched rules, chains, events, DNS behavior, and latency.
- Uses more than one profile and expects labels and hierarchy to be preserved.
- Needs exportable, redacted diagnostics and predictable advanced controls.

### Affected non-user: other devices and applications

The client changes operating-system networking and can affect every application
on the machine. Safe defaults, bounded privileges, and reliable rollback are
therefore product requirements, not implementation details.

## Goals

1. Complete the path `import -> validate -> activate -> capture -> observe -> stop`
   within one coherent product.
2. Make capture state, routing mode, active profile, and runtime health legible
   without duplicating them in multiple dashboards.
3. Preserve the Mihomo core's group-scoped routing model and never invent a
   global active node in Rule mode.
4. Keep expert inspection one step away while allowing daily operation from
   Status and the native status-bar menu.
5. Reuse one product model and accessible component system across browser,
   desktop WebView, and later mobile shells.

## Non-goals

- Hosting, selling, or discovering proxy services.
- A full YAML IDE or general-purpose rule authoring environment in the first
  releases.
- Stash-style HTTP rewriting, MitM certificate management, or scripting in the
  initial product.
- Long-term traffic accounting, billing-grade statistics, or employee
  monitoring.
- Remote control outside loopback in the first release.
- Inferring geography, provider, quality, or semantics from user-authored names.

## Product principles

1. **Outcome before configuration.** Status leads with capture and current
   activity; configuration details live in Profiles, Routes, and Settings.
2. **One fact, one home.** A value may have compact mirrors, but only one
   destination owns its full explanation and actions.
3. **Progressive disclosure.** Daily actions stay stable; expert controls are
   near the object they affect, not mixed into a universal settings page.
4. **Truth over convenience.** Heuristics are labeled and never presented as
   Mihomo core truth.
5. **Local trust.** No telemetry by default, no silent device identity, no
   provider-controlled native modules, and no unreviewed runtime assets.
6. **Commands are not navigation.** Routing modes and capture changes must look
   and behave like consequential state controls rather than page tabs.

## Information architecture

| Destination | User job | Explicitly does not own |
| --- | --- | --- |
| Status | Start/stop, mode, capture, live summary, frequent groups, service health | Full profile editing, full connection table |
| Routes | Browse complete policy-group tree, test, search, and select group children | Profile import and subscription credentials |
| Profiles | Import, validate, update, activate, and organize profiles | Runtime traffic investigation |
| Traffic | Inspect active/closed connections and matched route details | Long-term analytics and raw core logs |
| Events | Follow app/core/platform events and run guided diagnostics | General settings and rule editing |
| Settings | Configure application, capture, network, platform, update, and privacy behavior | Repeating live dashboard state |

On compact mobile layouts, Status remains Home; Routes becomes the primary
group tab; Profiles and diagnostic utilities may be nested under Tools; Settings
remains a bottom-level destination. This is a navigation adaptation, not a
different domain model.

## Release slices

| Slice | Proof of value | Included | Exit criteria |
| --- | --- | --- | --- |
| P0 macOS alpha | A valid profile can produce an observable System Proxy session | Local/URL import, validation, activation, Routes, Rule/Global/Direct, System Proxy, Status, Traffic, Events, stop/recovery | End-to-end acceptance journey passes on a clean macOS account |
| P1 macOS beta | Mish can replace an everyday desktop proxy client powered by the Mihomo core | TUN helper, status-bar commands, signed updates, guided diagnostics, profile refresh, robust sleep/wake/restart handling | Native validation gate and recovery tests pass on Intel and Apple Silicon |
| P2 desktop expansion | Shared product works on Windows and Linux | Platform adapters, packaging, service/privilege differences | Capability matrix and signed build gates pass per OS |
| P2 mobile feasibility | Shared UI can coexist with native VPN lifecycle | Android `VpnService` spike and iOS Packet Tunnel/TestFlight spike | Device VPN, entitlement, sleep/wake, and network-switch gates pass |

## Suite requirements

| ID | Priority | Requirement | Acceptance criteria |
| --- | --- | --- | --- |
| SUITE-F-001 | P0 | The product shall expose the six stable destinations defined above. | Given any primary desktop page, when the user navigates by pointer or keyboard, then destination labels remain visible and the active destination is announced accessibly. |
| SUITE-F-002 | P0 | The product shall expose one active profile context across all destinations. | Given profile A is active, when the user opens Status, Routes, Traffic, or Events, then every profile-scoped value belongs to profile A or is explicitly marked global. |
| SUITE-F-003 | P0 | Core commands shall expose idle, pending, success, and typed failure states. | Given a command is in flight, when the UI receives progress or failure, then duplicate submission is prevented and recovery guidance remains available. |
| SUITE-F-004 | P0 | Browser and desktop clients shall present the same product state through the local application API. | Given both clients are open, when a supported state changes in one client, then the other reconciles without requiring a full reload. |
| SUITE-F-005 | P0 | Unsupported platform capabilities shall be represented honestly. | Given a capability is unavailable, when its control is shown, then it is disabled or omitted with an explanation and no simulated success. |
| SUITE-F-006 | P1 | Common commands shall be available from the macOS status-bar menu. | Given the main window is closed, when the user opens the status menu, then capture, profile, group-scoped route selection, and window/browser commands remain available. |
| SUITE-F-007 | P0 | Empty states shall preserve the owning object's structure and next action. | Given no profile, routes, connections, rules, or events exist, then the page distinguishes missing prerequisite, zero data, disconnected source, and zero filter matches without hiding its eventual object model. |
| SUITE-F-008 | P1 | Main UI, status menu, and hotkeys shall execute the same named application commands. | Given a command is triggered from any supported surface, then pending, success, failure, and reconciled state use the same semantics and no surface maintains a private state copy. |
| SUITE-NF-001 | P0 | All core product assets shall ship offline. | Given the network is unavailable, when the installed client launches, then navigation, icons, styles, and error recovery render without CDN requests. |
| SUITE-NF-002 | P0 | Interactive product UI shall meet WCAG 2.2 AA intent. | Keyboard navigation, visible focus, contrast, reduced motion, text alternatives, and non-color status cues pass the project's accessibility checks. |
| SUITE-NF-003 | P0 | The local control plane shall bind to loopback and reject untrusted origins by default. | Security tests prove Host/Origin validation, authenticated RPC, bounded messages, and no unintended LAN listener. |
| SUITE-NF-004 | P1 | Idle operation shall remain suitable for an all-day utility. | Representative Intel and Apple Silicon measurements meet the agreed CPU, memory, wakeup, and animation budgets before beta. |

## Success metrics

- At least 4 of 5 representative users complete valid-profile import to healthy
  System Proxy in under five minutes without assistance.
- At least 90% of usability-test attempts correctly identify capture state,
  routing mode, and active profile within ten seconds.
- At least 80% of common failure scenarios are resolved from the surfaced action
  without terminal use.
- No P0 usability test participant interprets a group child as the globally
  active node in Rule mode.
- Crash-free and network-rollback gates are defined before public beta; exact
  numeric targets depend on the selected update and crash-reporting approach.

## Launch and learning plan

1. Validate P0 with deterministic fixtures and a pinned Mihomo build.
2. Dogfood on clean and existing macOS accounts with one local and one remote
   profile source.
3. Run explicit failure drills: malformed profile, core crash, stale System
   Proxy, no network, DNS failure, permission denial, and sleep/wake.
4. Ship an opt-in alpha. Do not make diagnostics or telemetry opt-out.
5. Enter public beta only after signed packaging, rollback, and TUN validation.

## Risks and open questions

| Item | Current position | Resolution |
| --- | --- | --- |
| Product brand | The independent product name is Mish; Mihomo is reserved for the upstream core and its integration boundaries. | Apply Mish consistently before public branding and signing. |
| Mobile shell feasibility | Shared React is confirmed; Apple extension integration remains the gate. | Complete device/TestFlight spike before scheduling mobile product work. |
| Profile transforms | Merge/script systems are useful but add a second configuration language and security surface. | Keep out of P0; review after profile lifecycle is reliable. |
| Update and crash evidence | No vendor or privacy contract is selected. | Choose an explicitly consented, open-source-compatible approach before beta metrics are finalized. |
