# Runtime State Ownership

## Scope

This document is the canonical ownership taxonomy and inventory for
application runtime state. It covers Rust, native adapters, the authenticated
bridge, shared contracts, and React. It records current implementation truth
separately from the target ownership decision.

This contract does not require Rust ownership merely because a value is useful
or long-lived. Rust authority is justified only when state must be coherent
across desktop, Browser Client, status bar, remounts, reconnects, or simultaneous
clients; participates in lifecycle, recovery, authorization, or command
decisions; or needs one atomic revision and order. Interaction, animation,
filter, dialog, draft, and focus state remains in the Web implementation.

The first migration is the recent capture-session Traffic slice. It must land
before lifecycle/race work can rely on its terms. Lifecycle work may refine how
transitions are serialized, but it must not redefine the taxonomy, capture
session identity, totals, retention, or publication contract here.

## Ownership taxonomy

Every state value has exactly one primary classification.

| Classification            | Meaning                                                                                                                        | Allowed Web behavior                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Authority**             | Application truth used for decisions, recovery, security, shared lifecycle, identity, or ordering.                             | Hold the latest validated DTO and invoke commands; never independently advance identity or revision. |
| **Derived DTO**           | A deterministic projection of authority or a fresh external observation. It is not a second writer.                            | Recompute for rendering; discard and rebuild on a new authoritative baseline.                        |
| **Bounded cache**         | Reconstructible state retained for performance or a deliberately local history. Loss changes latency or local continuity only. | Bound memory, name invalidation rules, and never use it as command authority.                        |
| **Optimistic projection** | Temporary predicted presentation while an authoritative command is pending.                                                    | Clear on confirmation, failure, authority replacement, reconnect, or remount.                        |
| **Presentation-only**     | Interaction and rendering state whose loss cannot change application truth.                                                    | Keep local to the narrowest Web Module.                                                              |

An **Authority** may be process-memory-only. Persistence is a separate decision,
not a stronger form of authority. A **Bounded cache** can survive a remount only
when doing so cannot turn it into application truth.

The deletion test applies to proposed Modules. The recent-traffic Module is
deep: deleting it would spread session identity, baselines, resets, retention,
and ordering back across every client. A Web wrapper that only renames the DTO
would be shallow and must not become a new Seam.

## Evidence-backed ownership matrix

Priority uses `P0` for the accepted first migration, `P1` for another proven
cross-surface inconsistency, `retain` for correct current ownership, and
`observe` when no migration is justified.

| Domain / semantic state                                                                             | Current owner and code evidence                                                                                                                                                                                                                        | Lifecycle and synchronization                                                                                                                                                                                                                                           | Current classification and failure mode                                                                                                                                                                                             | Target ownership / priority                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core rates and cumulative bytes                                                                     | `ControllerStatusMapper` in `crates/desktop-bridge/src/controller_status.rs` maps Mihomo Traffic observations into `mish_runtime::TrafficSnapshot`; `StatusSnapshot.traffic` publishes it through `status.subscribe`.                                  | A Controller source owns a mapper for one active Profile/runtime generation. The source retains at most `STATUS_TRAFFIC_SERIES_LIMIT` (512) rate values per direction.                                                                                                  | **Derived DTO** plus Rust **Bounded cache**. The cumulative values are Core-generation observations, not capture-session totals. They can reset when Core is replaced.                                                              | Keep as the low-level source. It is input to, not a substitute for, capture-session authority. `retain`.                                                                                     |
| Status capture-session baseline, totals, and sparkline                                              | The deep `RecentTraffic` Module in `crates/runtime/src/recent_traffic.rs` owns authority/session identity, source-generation baselines, totals, paired cadence samples, bounded retention, and revision. `status-page.tsx` derives render arrays only. | The lifecycle coordinator classifies suspend/resume continuity. `DesktopRuntimeHost` preserves process authority across same-Profile runtime replacement and resets before a different Profile or safe runtime is published. Status subscriptions carry one atomic DTO. | Rust process-memory **Authority** plus a Web **Derived DTO**. Remounts and clients share one snapshot; `RpcStatusClient` accepts authority replacement and only increasing same-authority revisions, including reconnect baselines. | Implemented in protocol version 24. Keep animation/interpolation **Presentation-only** and retain the low-level `traffic` compatibility field for this recorded window. `retain`.            |
| Core lifecycle, aggregate launch, capture selection, System Proxy and TUN observation               | `MishRuntime`, `ProfileActivationCoordinator`, capture reconciliation Modules, and platform adapters publish `RuntimeStatus`, activation snapshots, and native status-bar projections.                                                                 | Rust serializes mutations and re-observes Core, managed listener, operating-system proxy state, helper state, routes, and DNS. Status subscriptions provide a current baseline.                                                                                         | **Authority** and **Derived DTOs**. React pending flags and selected button values are **Optimistic projections** only. A Web pending flag disappearing on remount does not change the active transaction.                          | Rust remains authoritative. Do not move button loaders, dialog state, or animation state. `retain`.                                                                                          |
| Profile records, revisions, patches, refresh policy, provider lifecycle, and activation             | `crates/profile`, desktop bridge Profile store, activation coordinator, and provider snapshot own persisted records, immutable revisions, last-known-good activation, and provider command authority.                                                  | Profile subscriptions carry fresh baselines. Activation/runtime replacement changes the active Profile before Status and Traffic publish from the new runtime.                                                                                                          | **Authority** with Rust **Derived DTOs**. Web operation maps and waiters are local command coordination.                                                                                                                            | Rust remains authoritative. `retain`.                                                                                                                                                        |
| Profile selected for the next launch                                                                | `ProfileSelectionAuthority` in `crates/profile/src/selection.rs` atomically persists one validated Profile ID and monotonic revision; `ProfileSnapshot.selection` publishes it through the existing Profile RPC seam.                                  | The shared Profile/Settings mutation authority queues selection commands. Missing or deleted selections reconcile to the first valid stored Profile or explicit null. Desktop WebView, Browser Client, native launch, and application-start launch read the same state. | Rust persisted **Authority** plus temporary Web **Optimistic projection**. Web accepts only a greater selection revision and cannot send a Profile ID through the capture command. Selection never activates Core by itself.        | Implemented in protocol version 25. Keep Profile activation ordered before capture apply, and compose the nested selection revision with any future parent Profile snapshot epoch. `retain`. |
| Configured route catalog shown while Core is inactive                                               | `apps/web/src/data/configured-route-catalog.ts` requests the selected Profile's catalog and keeps the result in React state.                                                                                                                           | Rebuilt when the selected Profile changes; cancelled results are ignored; active runtime groups supersede it.                                                                                                                                                           | Web **Bounded cache** of persisted Profile authority. Loss causes a reload only. It is never command authority.                                                                                                                     | Keep Web-owned and ensure invalidation follows the future Rust-selected Profile revision. `retain`.                                                                                          |
| Routing mode and selector choice                                                                    | Controller commands in `controller_source.rs` revalidate membership and read back the Controller before `StatusSnapshot` publication.                                                                                                                  | Bound to active Profile/runtime generation; replacement invalidates old group IDs and tests.                                                                                                                                                                            | Rust/Controller **Authority** with **Derived DTOs**. `status-page.tsx` keeps temporary routing and capture selections only as **Optimistic projections**.                                                                           | Keep authority in Rust. `retain`.                                                                                                                                                            |
| Group usage and delay-test state                                                                    | `ControllerStatusMapper` deduplicates observed connection IDs and derives per-group counts; the Controller source owns one group-delay test lifecycle.                                                                                                 | Process-memory, Profile/runtime scoped, bounded by retention policy and invalidated on replacement.                                                                                                                                                                     | Rust **Derived DTO** and **Bounded cache**. Counts are observations, not billing or durable analytics.                                                                                                                              | Keep in process memory. Do not persist or treat as analytics. `retain`.                                                                                                                      |
| Service monitor definitions and probe interval                                                      | `ServiceProbeService` and settings-backed bridge composition validate and persist monitor definitions and interval policy.                                                                                                                             | Available independently of Core. Authenticated commands mutate then return a fresh Status snapshot.                                                                                                                                                                     | Rust **Authority**.                                                                                                                                                                                                                 | Keep Rust-owned. `retain`.                                                                                                                                                                   |
| Service probe result and manual-test pending feedback                                               | `ServiceProbeService` owns current results and a monotonically revised in-process probe snapshot; `ProductProvider` keeps per-monitor pending/failure feedback.                                                                                        | Probe results update the Status snapshot. Web pending feedback is cleared by a newer confirmed result, remount, or command completion.                                                                                                                                  | Results are Rust **Derived DTOs** and a **Bounded cache**. Command feedback is an **Optimistic projection**. A remount may lose a spinner but not probe truth.                                                                      | Keep current split. `retain`.                                                                                                                                                                |
| Detailed Traffic active connections, rules, close authority                                         | `mish_runtime::TrafficDataSnapshot` and the Controller source publish `profileId`, `sessionId`, `sequence`, phase, reconnect count, connections, and rules. Close commands require the matching authority tuple and re-observe results.                | Controller reconnect creates a new session; Profile/runtime replacement changes authority. RPC subscribe returns a baseline before updates.                                                                                                                             | Rust **Authority** for command targeting and **Derived DTOs** for observations. This session identifies the Controller Traffic source, not aggregate capture.                                                                       | Keep independent from recent capture-session Traffic. `retain`.                                                                                                                              |
| Detailed Traffic recently Closed rows and pause                                                     | `TrafficProvider` and `traffic-model.ts` derive disappeared connections, pause a local view, and support Clear Local.                                                                                                                                  | Bounded to one Web provider and rebuilt from Traffic snapshots. Clear Local intentionally affects one client only.                                                                                                                                                      | Web **Bounded cache** and **Presentation-only** pause state. Different clients may show different local Closed history by design; it never authorizes close commands.                                                               | Keep Web-owned. `retain`.                                                                                                                                                                    |
| Process icons for Traffic rows                                                                      | `TrafficProvider` stores data URLs and in-flight requests in `processIconCacheRef` and `processIconRequestsRef`.                                                                                                                                       | Per mounted provider, keyed by process path, lost on remount; completed icons are capped at 128 entries.                                                                                                                                                                | Web **Bounded cache**. Loss affects fetch cost only; values never affect process attribution authority.                                                                                                                             | Keep Web-owned. `retain`.                                                                                                                                                                    |
| Settings, language, appearance, startup, privacy, window behavior                                   | `crates/settings` persists validated preferences and the bridge publishes revised `SettingsSnapshot`; `SettingsLanguageProjection` maps confirmed language into the renderer.                                                                          | Atomic private app-data writes and settings subscription baseline/update. Native adapters confirm platform mutations before settings publication.                                                                                                                       | Rust **Authority**. DOM locale/theme and local no-flash theme values are **Derived DTOs** or narrowly scoped **Bounded caches**. Settings-page pending values are **Optimistic projections**.                                       | Keep current split. Browser fixture local storage is a fixture adapter, not desktop authority. `retain`.                                                                                     |
| Notification identity, ordering, read/removal/resolution, retention                                 | `mish_runtime::NotificationCenter` owns stable IDs, monotonic revisions, lifecycle, and 128-record process-memory retention; RPC subscriptions publish atomic baselines.                                                                               | Shared across runtime replacement in the current application process. Reconnect baseline never creates a toast.                                                                                                                                                         | Rust **Authority**. Localized entries are **Derived DTOs**; toast IDs, animation, and action-pending are **Presentation-only**.                                                                                                     | Keep current split and process-memory retention. `retain`.                                                                                                                                   |
| Events source session, sequence, redacted buffer                                                    | `mish_runtime::EventsSnapshot` and the Controller source own `profileId`, `sessionId`, `sequence`, phase, reconnect count, and at most 1,024 redacted events.                                                                                          | Reconnect and runtime replacement create a new source session. RPC resubscription publishes a fresh baseline.                                                                                                                                                           | Rust **Authority** for identity/order plus a Rust **Bounded cache**.                                                                                                                                                                | Keep in process memory with no persistence. `retain`.                                                                                                                                        |
| Events rendered buffer, Clear Local, pause/follow/filter state                                      | `events-model.ts` deduplicates one session into a 1,024-row Web buffer; `EventsProvider` and the page own local clear, diagnostic view, pause, follow, order, and filters.                                                                             | Replaced on `profileId` or `sessionId` change. Clear Local retains its seen-ID watermark for that client only.                                                                                                                                                          | Web **Bounded cache** and **Presentation-only** state. Different filters, pause positions, and cleared rows are intentional.                                                                                                        | Keep Web-owned. `retain`.                                                                                                                                                                    |
| Latest validated RPC snapshots and connection-stale flags                                           | RPC clients and React providers retain the newest schema-validated snapshot and transport state. Notification, Settings, Traffic, and Events reject stale revisions/sequences where their Interfaces define them.                                      | Replaced by the subscription baseline after reconnect.                                                                                                                                                                                                                  | Web **Bounded cache** of authority, not a writer. A stale cache may be displayed as stale but cannot manufacture success. Status currently lacks one whole-snapshot revision, which is lifecycle/race integration work.             | Keep caches. Any Status envelope revision must compose with, not replace, recent-traffic revision. `observe`, coordinated with #207.                                                         |
| Dialogs, menus, filters, search, focus restoration, hover, toast animation, sparkline interpolation | React pages and UI Modules.                                                                                                                                                                                                                            | Mounted-view lifetime.                                                                                                                                                                                                                                                  | **Presentation-only**.                                                                                                                                                                                                              | Never migrate to Rust. `retain`.                                                                                                                                                             |

## Resolved recent-Traffic divergence

Before protocol version 24, Status behavior was deterministic inside one
mounted hook but had no application-wide identity:

1. **Remount or Browser Client refresh.** The `useRef` disappears. The first
   post-mount source snapshot becomes a new baseline, totals return to zero,
   and every source sample already present is discarded even when capture has
   been active continuously.
2. **RPC reconnect.** Status resubscription correctly supplies an authoritative
   Status baseline, but the hook cannot tell a transport baseline from a new
   capture session. If React remains mounted, it may preserve old local history;
   if the tree remounts during recovery, it starts a different baseline.
3. **Two simultaneous clients.** Each client records its own first observation.
   Their totals and curves differ until capture stops. Neither result can be
   used by a status bar or another native surface.
4. **Missed stop/restart.** Reset depends on one client rendering a snapshot
   where both `systemProxyEnabled` and `tunEnabled` are false. A disconnect
   spanning stop and restart can join two capture sessions.
5. **Core or Profile replacement.** `appendedSamples` compares numeric suffixes
   without source identity. Coincidentally equal prefixes can be treated as
   overlap, while a new Core's cumulative counters can fall below the old
   client baseline and be clamped to zero. The result is safe from negative
   display but not semantically coherent.
6. **Cadence and window.** The 60-entry cap is a sample-count rule applied after
   render arrivals, not a time window. Delayed, bursty, or duplicated
   publications change the visible duration.

Protocol version 24 resolves these ownership failures with the deep Rust Module
described below. Memory, active-connection count, effective-rule count, and the
unchanged low-level Core Traffic observations remain derived.

## Implemented recent capture-session Traffic Interface

### Module and DTO

Rust owns one deep `RecentTraffic` **Module** inside the application runtime.
Its **Interface** accepts:

- authoritative aggregate capture transitions;
- validated Mihomo Traffic observations tagged with active Profile and Core
  generation;
- lifecycle invalidation/resume decisions from the existing coordinator; and
- a monotonic clock.

Its **Implementation** owns baselines, Core-generation offsets, cadence,
retention, session identity, sample order, and snapshot revision. Callers never
append canonical samples or subtract cumulative counters.
The Controller source advances the Module through its Rust publication sink
before broadcasting Status. Snapshot reads are pure projections and cannot
change history, so zero, one, or many connected clients produce the same state.

The transport DTO is logically:

```text
RecentTrafficSnapshot {
  authorityId: opaque process-instance ID
  revision: non-negative monotonic integer
  phase: "idle" | "active" | "suspended"
  sessionId: opaque capture-session ID | null
  profileId: stable Profile ID | null
  cadenceMilliseconds: 1000
  windowMilliseconds: 60000
  downloadedBytes: non-negative session-relative total
  uploadedBytes: non-negative session-relative total
  downloadBytesPerSecond: non-negative current valid rate
  uploadBytesPerSecond: non-negative current valid rate
  samples: [
    {
      sequence: positive integer scoped to sessionId
      offsetMilliseconds: non-negative monotonic session offset
      downloadBytesPerSecond: non-negative rate
      uploadBytesPerSecond: non-negative rate
    }
  ] // at most 60
}
```

The real Rust and TypeScript schemas may use project naming conventions, but
they must preserve these semantics. One paired sample prevents upload/download
arrays from drifting out of alignment.

### Identity, revision, and order

- `authorityId` is generated once per Mish application process. It is not
  persisted. A process restart creates a new value and resets `revision`.
- `revision` increases on every semantically different recent-Traffic snapshot:
  phase, identity, totals, current rates, or samples. A duplicate source
  observation does not advance it.
- `sessionId` is generated when aggregate capture first becomes
  authoritatively applied after idle. It is unique within `authorityId` and
  opaque to clients.
- `sequence` starts at 1 for the first retained sample in a session and strictly
  increases even after older samples are evicted. It never restarts during a
  suspended/resumed continuation.
- A subscription response is an ordering barrier. The server installs the
  receiver, captures one atomic snapshot, and returns it before later updates.
  The client applies the same nested revision guard to the baseline, queued
  subscription updates, and command results.
- A client replaces cached authority when `authorityId` changes. Within one
  authority, including across reconnect baselines, it ignores snapshots whose
  revision is not greater than the accepted revision.

### Cadence and bounded window

- The canonical cadence is one second, driven by Rust monotonic time rather
  than React renders or RPC delivery count.
- While `active` and a fresh validated Traffic observation is available, at
  most one paired sample is committed per cadence slot. Multiple observations
  in one slot use the newest validated observation.
- Missing or invalid slots are gaps, not synthetic zero traffic. The Module
  does not append while `suspended`.
- Retention is both time- and count-bounded: evict samples older than 60 seconds
  relative to the newest committed monotonic offset and retain at most 60.
- Current rates are zero in `idle`. In `suspended`, the DTO must mark the phase
  and must not present the last rate as current; the numeric current rates are
  zero while retained samples and totals remain available for continuity.
- React derives sparkline arrays from the paired samples and may animate or
  interpolate locally. Interpolation never feeds totals, sample sequence, or
  command decisions.

### Totals and baselines

- At session start, the Module records the first valid raw cumulative
  download/upload counters for the active Core generation. Session totals begin
  at zero; the baseline observation is not a rate sample.
- Within one Core generation, totals are the non-negative delta from the last
  accepted raw counters plus any committed generation offset.
- A raw counter decrease invalidates that generation baseline. Rust commits the
  prior generation contribution, establishes a new raw baseline, and never
  subtracts across generations.
- Total arithmetic is saturating and monotonic within a session. Invalid,
  duplicated, or out-of-order source observations cannot reduce totals.
- Totals are capture-session totals, not the lifetime Core totals and not the
  detailed Traffic workspace's per-connection sum.

### Reset and lifecycle rules

| Event                                                                                                 | Required result                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit aggregate start, first confirmed System Proxy or TUN apply                                   | Create a new session, bind the active Profile, record a fresh raw baseline, publish `active`.                                                                                                                                                   |
| One capture mode stops while the other remains confirmed                                              | Keep the same session and sequence.                                                                                                                                                                                                             |
| Explicit aggregate stop reaches confirmed no-capture state                                            | Publish `idle` with null session/Profile, zero totals/rates, and no samples. The idle revision is the reset barrier.                                                                                                                            |
| Capture selection changes while aggregate capture remains continuously applied                        | Keep the same session. Selection is intent, not Traffic identity.                                                                                                                                                                               |
| Capture failure or drift makes observations temporarily non-authoritative without an explicit release | Publish `suspended`, retain bounded samples/totals, and append nothing. Resume the same session only when the lifecycle coordinator confirms continuity.                                                                                        |
| Same-Profile managed Core restart/reconnect with retained capture intent                              | Suspend. If the coordinator re-establishes the same logical aggregate capture without an explicit stop, retain `sessionId`, start a new raw counter generation, and resume. A plain Controller reconnect alone never creates a capture session. |
| Unmanaged Core loss, failed recovery, or coordinator-declared discontinuity                           | End the old session at the first authoritative discontinuity and publish idle. A later apply creates a new session.                                                                                                                             |
| Active Profile switch or activation replacement                                                       | End the old session before publishing the new Profile runtime. If capture is re-applied, create a new session bound to the new Profile even when there was no visible Web idle frame.                                                           |
| RPC disconnect/reconnect or React remount                                                             | No authority change. The baseline returns the same session, totals, samples, and revision.                                                                                                                                                      |
| Second simultaneous client                                                                            | Both clients receive the same baseline and revisions. Clients do not register independent samplers.                                                                                                                                             |
| Application process restart                                                                           | No restoration. New `authorityId`, idle state, empty retention. A later confirmed apply creates a new session.                                                                                                                                  |

The lifecycle coordinator is the only Adapter allowed to classify continuity
after Core loss. RecentTraffic does not infer it from a remembered Web
selection, PID, Controller connection, or equal cumulative counters. This keeps
the lifecycle policy behind the existing Rust Seam and avoids a second race
authority. Integration work for #207 must call this Interface after its
serialized transition decision.

### Persistence, privacy, and retention

Recent Traffic is process-memory-only. There is no product need to recover a
sparkline after application restart, and persistence would turn transient usage
into a durable activity record without user value.

The Module stores only the current session identity, active Profile ID, bounded
numeric rates/totals, monotonic offsets, source-generation baselines, and
revision metadata. It does not store destination, process, rule, host, IP,
credential, URL, packet content, or wall-clock history. It performs no remote
upload and emits no analytics. Support bundles may report only closed aggregate
facts already permitted by their contract; they must not include the sample
series or session ID without a separate privacy decision.

### Compatibility and cutover

Protocol version 24 completed the end-to-end vertical slice:

1. The Rust Module, deterministic clock/source adapters for tests, Rust DTO,
   shared schema, and a new bridge protocol version.
2. `recentTraffic` is published atomically in the Status baseline and updates.
   The capture reconciler invokes the Module's confirmed-state observer before
   broadcasting a terminal capture projection, so a terminal Status update
   cannot expose the prior recent-Traffic phase.
   During one protocol version, retain the existing low-level `traffic` field
   unchanged for compatible clients and fixtures.
3. Status rendering consumes `recentTraffic`; `useStatusSessionTraffic`, its
   overlap heuristic, and its client baseline were deleted.
   The Web projection may convert paired samples to the existing sparkline
   props.
4. Fixtures generate explicit authority/session/revision values.
   `RpcStatusClient` never synthesizes production authority.
5. After all in-repository clients require the new protocol, a later cleanup
   may rename or remove low-level legacy series. That cleanup is not required
   for the authority cutover and must not block it.

There is no dual-writer period. As soon as the Web client consumes
`recentTraffic`, React must not independently append samples or subtract
baselines.

## Migration slices

Only proven misplaced global state becomes implementation work.

### Slice A — Rust-authoritative recent capture-session Traffic (`P0`, delivered)

**Dependency:** this ownership contract; coordinate transition ordering with
#207, but keep the taxonomy and Traffic semantics canonical here.

**Delivery:** protocol version 24 implements the complete compatibility/cutover
sequence above, including desktop/browser simultaneous consumers and the
existing fixture adapter.

**Tests through the Interface:**

- deterministic cadence, duplicate observations, gaps, stale revisions, and
  60-sample/60-second retention;
- start baseline, one-mode continuation, explicit stop/reset/restart;
- same-Profile Core generation reset with continuity and discontinuity;
- Profile replacement reset;
- RPC reconnect baseline, React remount, and two simultaneous subscribers;
- process restart/no persistence; and
- old low-level `traffic` compatibility during the recorded protocol window.

**Acceptance style:** confirmation-only. Rust, contract, RPC, Web unit, focused
browser rendering, `pnpm check:pr`, and Fast PR gate must pass. Evidence must
show identical session ID, totals, sample order, and revision for simultaneous
clients.

### Slice B — Rust-authoritative selected Profile intent (`P1`, delivered after Slice A)

**Dependency:** existing Profile/settings persistence and activation
coordinator. It is independent of recent-Traffic sampling behavior.

**Delivery:** protocol version 25 moves the next-launch selected Profile into a
revisioned, atomically persisted Rust preference. `ProfileSnapshot.selection`
publishes it to Web and native consumers, and every aggregate capture start
reads it inside the Rust launch transaction. Production no longer reads or
writes `mish.selected-profile-id`. The inactive configured-route catalog
remains a one-entry Web **Bounded cache** keyed by the confirmed selection
revision.

**Tests through the Interface:**

- desktop WebView and Browser Client observe one selection;
- simultaneous selection commands have deterministic revision order;
- remount and RPC reconnect preserve the confirmed value;
- deleted/missing Profiles reconcile to a safe valid value;
- selection does not activate Core; and
- a later capture start uses the confirmed selection while stale optimistic
  projections cannot win.

**Acceptance style:** confirmation-only. Rust persistence/bridge, shared
contract, Web provider, start-path tests, `pnpm check:pr`, and Fast PR gate must
pass.

No issue is justified for presentation pending flags, Events Clear Local,
Traffic pause/Closed history, notification toast state, configured-route
catalog caching, theme no-flash caching, or interaction/animation state.

## Acceptance inventory

This document is complete only while deterministic repository inspection
confirms:

- the current React baseline and 60-sample behavior;
- the low-level Rust Traffic source and its 512-sample bound;
- detailed Traffic source identity and order;
- Rust persistence, revision, and reconciliation of selected Profile intent;
- Rust notification identity/revision/retention authority;
- Rust and Web Events retention plus session replacement; and
- meaningful Web caches and optimistic/presentation state named in the matrix.

`scripts/check-runtime-state-ownership.ts` binds those facts and the required
contract sections to `pnpm check:docs`. When implementation slices change an
ownership fact, the same change must update this document and its inspection
anchors.
