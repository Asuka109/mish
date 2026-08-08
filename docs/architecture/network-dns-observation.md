# macOS Network and DNS Observation

## Scope and authority

Settings exposes one read-only macOS observation for local troubleshooting. It
reports every active interface listed by System Configuration, matching enabled
network-service names when macOS provides them, confirmed interface categories, IPv4 and IPv6
availability, DNS resolver counts, DNS servers, search domains, observation
time, freshness, source, and a typed failure category. It does not report
interface addresses and cannot change an interface, route, network service, or
DNS value.

The source label `macos-system-configuration` means the observation was derived
from the current System Configuration state through the fixed macOS tools
`/usr/sbin/scutil --nwi`, `/usr/sbin/scutil --dns`, and
`/usr/sbin/networksetup -listnetworkserviceorder`. Apple's
[System Configuration framework](https://developer.apple.com/documentation/systemconfiguration)
is the authority for current network configuration, and
[`SCDynamicStore`](https://developer.apple.com/documentation/systemconfiguration/scdynamicstore-gb2)
contains current network-state values and provides change notifications. The
adapter does not infer a service name or interface category when those fixed
outputs cannot establish the mapping.

The three commands use absolute executable paths and independent argument
vectors. They receive no RPC, profile, environment-derived, or UI-derived
argument. Execution has a five-second deadline, `kill_on_drop`, piped stdout and
stderr with independent 64 KiB hard limits, strict UTF-8 decoding, bounded
collections, and closed parsers. Raw stderr and rejected output are never
returned to RPC, logs, events, or error strings. Failures map only to
`command-failed`, `command-unavailable`, `timed-out`, `output-too-large`, or
`invalid-output`. Mish does not treat the first active interface as an inferred
primary interface.

## Freshness lifecycle

The Settings service owns a monotonically increasing observation authority.
Sleep, wake, primary-network changes, Core unavailability, and Core restart
boundaries invalidate the prior generation before any new observation begins.
A retained successful observation becomes `stale`; a state with no prior
successful observation becomes `unknown`. Neither phase is current.

Wake, network change, and a healthy Core boundary request a new observation.
Concurrent requests are serialized and deduplicated. A completion captures its
starting authority and is discarded if the authority changed while the command
was running, so an old result cannot republish itself as current. Only a result
from the active generation becomes `ready` and receives a new `observedAt`
timestamp. A failed refresh is `failed`; retained values, if any, remain visibly
non-current.

Every accepted invalidation and refresh is projected into one complete Settings
snapshot and published to all current Rust/RPC subscribers. Its Settings
`applicationOrder.order` advances when the public observation changes while the
durable preference `revision` remains unchanged. Lifecycle-triggered refreshes
use this same publication path as the user-triggered RPC action; the initiating
caller does not receive a private observation unavailable to other clients.

Authenticated RPC exposes only `settings.getSnapshot` and the empty-parameter
`settings.refreshNetworkDns` action for this data. The Web client aborts its
request when the view is disposed and suppresses duplicate refresh controls
while any Settings operation is pending. The server-side command deadline is
the final bound if a client disappears. Ordinary browsers and non-macOS desktop
compositions expose `unavailable`; fixture data is never promoted to a device
observation.

## Privacy

Network-service names, interface identifiers, DNS servers, and search domains
can reveal private device or organization context. They exist only in the
process-local Settings snapshot and the authenticated local WebView response.
They are not persisted in `settings.json`, emitted as Events, written to logs,
included in errors, or copied into support bundles. Interface IP addresses are
not part of the contract at all.

Support bundles continue to exclude raw network addresses and hostnames. If a
future bundle needs Network and DNS diagnostics, its schema may contain only a
safe summary such as availability, resolver/server/search-domain counts,
freshness, and the typed failure category. Adding raw values requires a separate
privacy design and explicit reviewed scope.

The observation adds no listener. The existing authenticated exact-origin IPv4
loopback bridge remains the only RPC transport, and no shell string, executable
path, interface parameter, or DNS mutation value is accepted.
