# Guided Diagnostics Data Contracts

## Scope

Guided Diagnostics is an Events-owned, transport-neutral, read-only application
contract. A run begins only after an authenticated user action. Mish does not
schedule background runs, upload results, emit telemetry, export a bundle, read
arbitrary files, or accept a caller-supplied URL, hostname, timeout, Controller
path, credential, raw configuration, routing mode, or group selection.

The desktop bridge retains at most eight runs in process memory. A browser
fixture retains the same bound but uses only explicit fictional results. Neither
history is persisted.

## Run and check shape

`DiagnosticRun` binds one start time, optional finish time, adapter kind, active
Profile ID, fixed probe policy, terminal state, and at most 16 checks. Terminal
states are `completed`, `cancelled`, and `invalidated`; only `running` omits a
finish time.

Every `DiagnosticCheck` separately contains a typed layer, status and failure;
a scope and structured route target; start and finish times; a structured
observed fact; and a plain-language interpretation.

Observed facts contain only closed enums, booleans, counts, HTTP status, elapsed
time, the pinned version, and profile-scoped hashed group or child IDs. They do
not contain endpoint URLs, resolved IP addresses, Profile or node labels,
Controller errors, subscription URLs, credentials, configuration, or full
paths. Interpretations are application-owned static text and never interpolate
raw network or Controller errors.

One successful endpoint check is interpreted only as success for that endpoint
and route. It is never presented as proof of global internet health.

## Fixed probe policy

Policy `mish-guided-diagnostics-v1` is compiled into the desktop bridge:

- the same pinned HTTPS `GET` endpoint as `mihomo-google-204-v1`;
- expected status `204`;
- five-second DNS, connect, and total request bounds;
- redirect following disabled;
- direct HTTP uses a Reqwest client with automatic system and environment proxy
  use disabled; and
- proxy reachability uses Mihomo's per-proxy delay endpoint with the existing
  `mihomo-google-204-v1` application policy.

Tokio's `lookup_host` performs only the basic system DNS lookup and Mish retains
only the answer count. Reqwest documents that `ClientBuilder::no_proxy()` also
disables automatic system proxy use. The pinned Mihomo v1.19.29
`GET /proxies/{name}/delay` handler calls `proxy.URLTest`; Mish does not use the
group delay handler because that handler can clear automatic group selection.

The proxy target is derived inside the active Controller source. Mish chooses
one currently selected child of one current group, probes it, then revalidates
the pinned version and direct group membership. RPC cannot select or name the
target. If no stable selected target exists, the check is `unavailable`.

Upstream references:

- [Mihomo v1.19.29 proxy delay handler](https://github.com/MetaCubeX/mihomo/blob/v1.19.29/hub/route/proxies.go#L734-L802)
- [Mihomo v1.19.29 group delay handler](https://github.com/MetaCubeX/mihomo/blob/v1.19.29/hub/route/groups.go#L516-L582)
- [Reqwest `ClientBuilder::no_proxy`](https://docs.rs/reqwest/0.13.2/reqwest/struct.ClientBuilder.html#method.no_proxy)
- [Tokio `lookup_host`](https://docs.rs/tokio/1.53.0/tokio/net/fn.lookup_host.html)

## Layer order and availability

A run records desktop bridge reachability, pinned core health/version, active
Profile context, capture desired/observed/drift, DNS, direct reachability, and
one explicit group/child-scoped proxy reachability check. Core, Profile, and
capture checks read existing authoritative state. They do not start or stop the
core, activate a Profile, reconcile capture, recover System Proxy, select a
group, change routing mode, or close a connection.

DNS and direct checks are available only in the desktop bridge composition.
Proxy checks require a ready pinned Controller source and a stable scoped target.
Missing capability, Controller loss, version drift, and inconsistent membership
produce typed failure or `unavailable` results. Mish does not infer a result
from another layer.

## Cancellation and runtime replacement

`diagnostics.startRun` and `diagnostics.getHistory` accept only an empty object.
`diagnostics.cancelRun` accepts only the bounded run ID. All three require the
same authentication-first RPC session as other desktop methods.

Cancellation is cooperative at each bounded external probe and terminally marks
the run. `DesktopRuntimeHost::replace` first invalidates and cancels an active
run, then publishes the replacement runtime. A task also compares runtime
instance authority between checks. Results from two runtime/Profile contexts
therefore never form one run.

The WebView polls history only while an already-started run is active. Polling
does not start a check. Common failure rows and Status warnings link to the
Diagnostics section; the link performs no recovery.

## Explicit exclusions

This slice defines no export, upload, clipboard copy, arbitrary probe endpoint,
service editor, persistent history, automatic schedule, telemetry, or recovery
command. Those capabilities require separate privacy and product contracts.
