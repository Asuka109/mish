# macOS Bonjour and System Proxy Boundary

## Decision

When Mish System Proxy is active, every RFC 6762 `.local.` name remains owned
by macOS Bonjour/mDNS. Before the managed loopback HTTP, HTTPS, and SOCKS
proxies are reported as applied, Mish adds this restricted macOS proxy-bypass
contract:

- `localhost`, `*.localhost`
- `*.local`, `*.local.`
- `*.home.arpa`, `*.home.arpa.`

The `.local` entries cover ordinary and canonical trailing-root-dot spellings.
DNS names are case-insensitive, so normal hostname matching also covers
`nas.local` and `NAS.LOCAL`; the wildcard covers reasonable nested names such
as `printer.lab.local`. The `localhost` and `home.arpa` entries cover standard
local special-use namespaces without widening the bypass to private address
ranges. This is intentionally a hostname-only exception. It does not
permanently direct all private address ranges, disable Mihomo DNS, or modify
the active network service's DNS, routes, or Bonjour configuration.

[Apple documents](https://support.apple.com/guide/mac-help/enter-proxy-server-settings-on-mac-mchlp25912/mac)
that the Network proxy pane can bypass selected hosts and domains, including
wildcard domain entries. [RFC 6762](https://www.rfc-editor.org/rfc/rfc6762)
defines `.local.` as the link-local Multicast DNS namespace, and
[Apple identifies](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
`.local` / `.local.` as Bonjour local DNS names. The implementation therefore
uses the macOS proxy decision point rather than attempting to send a multicast
name to ordinary DNS or a remote proxy. [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761)
defines the localhost special-use behavior, and [RFC 8375](https://www.rfc-editor.org/rfc/rfc8375)
reserves `home.arpa.` for home networks.

## Ownership and recovery

`NetworkServiceProxyState` includes the complete ordered bypass-domain list.
On activation Mish reads the list, preserves every existing value and order,
then appends only missing case-insensitive members of its local-name contract. It
does not reorder, deduplicate, or replace user entries. The exact original list
is stored in the private recovery journal alongside the existing proxy fields.

The active target must be confirmed byte-for-byte, including bypass ordering.
The bypass list is part of transaction ownership, drift detection, rollback,
restart recovery, service-switch restoration, stop, and quit. A missing or
changed managed entry is drift, never `Applied`; Mish leaves third-party changes
alone under the existing conservative recovery policy.

The journal version intentionally changed with this field. An older journal
cannot prove the previous bypass list and is rejected rather than risk clearing
unknown user-owned state.

## TUN boundary

This decision repairs only the current System Proxy path. In that path macOS
chooses the bypass before a request reaches the loopback proxy, so there is no
Mihomo DNS/route event to fake in a Core test.

TUN is materially different: [Mihomo's TUN configuration](https://wiki.metacubex.one/en/config/inbound/tun/)
supports DNS hijack, and Mish's fixed TUN profile enables `any:53` while the
privileged helper owns interface, route, and DNS observation.
No System Proxy bypass proves that multicast DNS is preserved after TUN capture.
The required production TUN work is an independently verified helper/Core
policy that preserves mDNS multicast and `.local.` resolution; until then this
repository makes no claim that TUN fixes this compatibility case. See
[`macos-tun-helper.md`](macos-tun-helper.md).

## Evidence boundary

The automated fixture tests prove that the active System Proxy target includes
the local-name bypass contract, that user bypass entries survive in order, and that
confirmation, drift, rollback, restart recovery, and stop restore exact state.
They do not mutate a host network service or query a real LAN device. Real
Bonjour delivery remains hands-on acceptance with a user-selected local device.
