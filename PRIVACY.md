# Privacy

This document describes the current repository behavior. It is not a universal
compliance statement, a promise about future versions, or legal advice.

## Product model

Mish is local-first client software. The repository does not configure a Mish
account service, hosted control plane, telemetry pipeline, analytics SDK, crash
reporter, advertising SDK, or automatic updater. Mish does not sell or provide
profiles, subscriptions, proxy servers, VPN endpoints, or other network access.

Local-first does not mean offline. A user's configuration and explicit or
scheduled actions can cause network requests and traffic processing.

## Data stored on the device

The desktop application stores application state under the operating system's
app-data location for `com.asuka109.mish`. Depending on the features used, this
can include:

- imported profile content and HTTPS profile source addresses;
- settings, selected profile, routing preferences, and provider schedules;
- managed Core ownership, activation, and recovery records;
- System Proxy recovery state;
- bounded service-monitor configuration and observations; and
- local runtime files produced by the pinned Mihomo Core.

Mish also retains bounded event and connection information in memory for the
current application session. User-selected support bundles and backups are
written only to the destination selected by the user. A backup may contain
sensitive profile or settings data when the user explicitly includes those
categories.

## Network activity

Current desktop behavior can make these outbound requests:

- download a profile from a user-supplied HTTPS address during import or a
  configured refresh;
- let Mihomo process traffic and access providers, DNS services, geodata, and
  other resources selected by the active profile;
- update a configured Mihomo provider after explicit action or an enabled
  schedule;
- run route delay tests against the repository's pinned connectivity-test
  endpoint through Mihomo;
- send direct HTTP GET service probes to the configured monitor endpoints,
  including the default Google, GitHub, Cloudflare, Baidu, Apple, and Microsoft
  presets, immediately after startup and at the selected interval; and
- request default service icon SVGs from
  `https://registry.npmmirror.com/remixicon/4.9.1/` when those icons render.

Normal desktop builds bundle the primary interface, fonts, brand assets, and
onboarding artwork locally. Development and packaging commands can separately
download pinned toolchains or Mihomo artifacts as documented in their command
output and repository manifests.

The offline browser demo uses fictional snapshots and does not execute the
desktop service probes or native effects. Opening external links in repository
documentation is an ordinary browser action outside Mish's application runtime.

## Local access and exports

The desktop bridge binds to loopback, validates the requesting origin, and
requires an application-created credential. It is not a LAN or hosted control
service. These controls do not make data safe if the device, user account,
profile, dependency, or exported file is already compromised.

Support bundles are locally generated and previewed before saving. The
application applies bounded redaction rules, but a maintainer and user must
still review every export before sharing it. Do not post support bundles,
profiles, screenshots, or logs publicly without checking for private labels,
addresses, credentials, destinations, and paths.

## Deletion

Profiles and settings can be changed or removed through the application. To
remove a macOS test installation and its local state, first stop capture and
quit normally, then follow the exact cleanup procedure in
[`docs/operations/macos-packaging.md`](docs/operations/macos-packaging.md).
User-selected exports and backups remain at their chosen destinations and must
be removed separately.

## Open policy questions

Before any public distribution, the maintainer must decide and document the
release territories, support and contact policy, data-retention expectations,
whether remote service icons remain enabled by default, and whether additional
platform or jurisdiction-specific notices are required. Those decisions require
maintainer and, where appropriate, qualified legal review.
