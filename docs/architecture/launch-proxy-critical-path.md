# Launch Proxy critical path

## Authority and entry points

`ProfileActivationCoordinator::launch_proxy` is the single Rust authority for
aggregate proxy launch. The authenticated browser and desktop WebView enter
through `status.setCapture`; the native status menu and launch-at-startup path
call the same coordinator directly. Callers cannot publish Running or apply
System Proxy themselves.

The coordinator keeps one `proxy_operation` guard for the whole aggregate
transition. A concurrent Launch is rejected. Stop and graceful quit cancel a
Pending Profile activation, wait for that one aggregate operation to join, and
then confirm Capture-off. No detached System Proxy preparation or mutation task
survives the command.

## Critical-path DAG

```text
Launch command
  |
  +--> publish Rust Capture Pending
  |
  +--> Profile/Core branch
  |      repository record + runtime policy
  |      admitted TUN selection requires a fresh healthy Helper snapshot
  |      managed proxy listener preflight
  |      candidate staging
  |      Mihomo `-t` validation and owned GeoData preparation
  |      prior Core/capture handoff when required
  |      candidate Core spawn
  |      Controller + Status + Traffic + Events readiness
  |      activation-state commit and runtime publication
  |
  +--> read-only System Proxy preflight
         capability + recovery-journal read
         active-service discovery
         complete proxy/PAC/auto-discovery observation

Both branches joined successfully
  |
  +--> healthy managed-listener confirmation
  +--> recovery-journal re-read
  +--> complete active-service/state re-observation
  +--> reject typed drift if the preflight fingerprint changed
  +--> exact prior-state journal save
  +--> ordered OS mutation
  +--> post-write observation/confirmation
  +--> Rust Applied/Running publication
```

The preflight branch is read-only. Its state and journal snapshot are opaque
in-process data: they are never serialized or logged because they may contain
service names, proxy hosts, or PAC URLs. They are preliminary evidence, not
mutation authority. The final transaction always confirms the listener first,
then reloads the journal and re-observes the complete active-service state. A
changed service, field, or journal produces the existing typed drift/rejection
path with zero OS writes.

A preflight rejection is published to the Rust Notification Center as soon as
the read-only check returns it. Capture and Profile activation remain Pending
while the coordinator cancels and joins the Profile/Core branch, so the user
can see the actionable failure without waiting for GeoData/Core cleanup while
single-flight launch ownership still prevents another operation from crossing
the cleanup boundary. The launch RPC returns the same typed error only after
cleanup is complete.

The Profile/Core branch follows the same fail-fast rule. A cold TUN selection
must prove current Helper health before candidate preparation, so an install or
repair requirement takes precedence over unrelated listener/Core failures. The
desktop Status control opens the existing authenticated Helper installation
flow before issuing a TUN Capture command when permission is required. A
foreign owner of the fixed managed proxy endpoint is rejected before staging,
Mihomo validation, owned GeoData preparation, or Core spawn. An already-active
Mish Core may retain that exact endpoint only with live ownership proof during
transactional handoff. Controller and proxy ownership are checked again after
spawn/readiness; the early bind check is rejection evidence and never replaces
commit-boundary confirmation.

## Deterministic before/after evidence

The pre-change aggregate handoff test proved only that public Pending did not
fall back to Off. New barrier fixtures exercise the actual coordinator and
platform seams without asserting that CI is unrealistically fast:

- Before the change, a Profile/Core readiness barrier could remain blocked
  without any System Proxy observation starting. The overlap fixture therefore
  timed out while waiting for the first read-only observation.
- After the change, that observation reaches the fixture while Profile/Core is
  still blocked. Stop, preflight failure, and graceful quit cancel/join the
  activation; the fixture observes zero apply calls.
- A deliberately one-second candidate combined with an occupied managed proxy
  endpoint now publishes the typed conflict notification in under the
  pre-start bound, proving that candidate startup is not on the error path. A
  separate fixture claims the endpoint only after staging and proves the
  existing use-time check rejects it and removes the candidate before commit.
  A cold TUN fixture with both an unhealthy policy-time Helper and an occupied
  port proves the Helper prerequisite wins before either listener or Core
  preparation.
- Before the change, one macOS active-state observation required seven serial
  command rounds: default route, network service order, then HTTP, HTTPS,
  SOCKS, PAC, and auto-discovery getters.
- After the change, the two discovery commands form one concurrent round and
  the five independent getters form a second concurrent round. A barrier test
  requires every member of each group to be in flight together and verifies the
  same parsed state.
- Final mutation still performs a fresh two-round observation after listener
  readiness. A separate fixture changes the preliminary fingerprint and proves
  typed `external-drift`, no journal, no apply, and no Applied publication.

This is a command-round reduction, not a wall-clock promise. Real `networksetup`
and route latency varies by macOS version, network services, cold process
startup, and machine load.

## Runtime cases

| Case                                     | Profile/Core branch                                                                                | System Proxy behavior                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Cold Profile or missing GeoData          | Candidate staging, Mihomo validation/download, Core startup, and readiness are on the long branch. | Read-only preflight overlaps that work; the full fingerprint is revalidated after readiness.                                    |
| Warm retained Core and matching Profile  | Activation is already successful.                                                                  | There may be little cross-branch overlap, but each macOS observation still uses two read rounds instead of seven serial rounds. |
| First launch without a journal           | No prior Mish ownership exists.                                                                    | Preflight applies takeover protections; final observation must match before the prior state is journaled.                       |
| Relaunch after safe stop                 | A healthy managed Core may remain intentionally retained.                                          | A new preflight and final validation run; the previous journal must already have been cleared by exact restoration.             |
| System Proxy already running             | No new Profile activation or preliminary baseline is needed.                                       | The existing idempotent Capture path runs and timing evidence reports `already-running`.                                        |
| Service/state changes during preparation | Profile/Core may still finish safely.                                                              | Final fingerprint comparison rejects the launch as drift and performs no OS mutation.                                           |

## GeoData ownership boundary

Mish generates a private candidate home and starts pinned Mihomo with `-t`.
Mihomo v1.19.29 owns any missing GeoData download inside that validation
process. Mish observes only an allowlisted progress/failure surface, enforces
the separate GeoData deadline, propagates cancellation, drains bounded output,
and deletes the failed candidate. Mish does not know the internal download
transaction well enough to move it, seed it, or coordinate it with System
Proxy, so Launch optimization deliberately leaves that download ownership
unchanged.

## Timing evidence and privacy

Every completed aggregate launch attempt appends a Debug application event
named `Launch Proxy timing`. Its detail is a schema-versioned JSON object with:

- `totalMs`
- `profileCoreMs`
- `systemProxyPreflightMs`
- `preparationWallMs`
- `overlapMs`
- `listenerJournalMutationConfirmationMs`
- `outcome`

The event contains only bounded durations, a closed outcome, and schema
version. It never includes Profile identifiers or names, user paths, services,
hosts, endpoints, proxy contents, PAC URLs, credentials, nodes, or Core output.
The Events surface is therefore the installed-app evidence source for comparing
cold and warm Pending time without exposing private configuration.

## Locking and remaining critical path

The aggregate `proxy_operation` guard intentionally spans launch so desktop,
status-menu, and browser callers remain single-flight. The activation manager's
state mutex intentionally serializes the transactional candidate/Core handoff.
No coordinator state mutex is held while joining preflight with activation, and
the read-only preflight does not hold the Capture mutation lock.

Journal persistence, listener confirmation, final full-state observation,
ordered OS writes, and post-write confirmation remain serial. They establish
ownership and prevent the machine from pointing at an unavailable listener.
The preliminary journal and state reads are repeated at commit time by design;
removing that repeated I/O would make stale preflight data authoritative.

The deterministic, non-privileged system evidence for early listener-conflict
notification, finalization ownership, duplicate admission, and commit-boundary
TOCTOU rejection is specified in
[`transcript-driven-system-tests.md`](transcript-driven-system-tests.md).
