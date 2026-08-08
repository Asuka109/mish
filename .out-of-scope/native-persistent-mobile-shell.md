# Native Persistent Mobile Shell

## Status

Rejected and not planned as of 2026-08-04. The installed mobile Web shell is
the sole owner of persistent product chrome and navigation.

This record covers the withdrawn direction in which Android Material or Apple
system tabs, bars, drawers, or sidebars would surround one WebView while Shared
Rust owned a separate top-level shell selection. It does not reject Native code
for real platform effects.

## Observable reason

Hands-on review of the exact Android candidate from
[#373](https://github.com/Asuka109/mish/issues/373) and
[PR #386](https://github.com/Asuka109/mish/pull/386) showed that the proposed
boundary still had two navigation owners. Product child routes must be able to
cover the selected tab root, while their history, Back behavior, focus,
overlays, and business sheets remain inside the WebView. Keeping persistent
tabs and bars outside that WebView made the visible hierarchy and Back/overlay
semantics split across Native and Web even without mirroring the current Web
path into Native.

The existing React `MobileShell` and React Router therefore own, together:

- persistent top and bottom mobile chrome;
- top-level destinations and child routes;
- internal history and Back;
- page and business overlays/sheets; and
- route focus and DOM focus.

## Evidence and supersession

- [#343](https://github.com/Asuka109/mish/issues/343) and
  [PR #370](https://github.com/Asuka109/mish/pull/370) remain historical
  research and prototype evidence. Their Native persistent-chrome
  recommendation is superseded.
- [#372](https://github.com/Asuka109/mish/issues/372) and
  [PR #375](https://github.com/Asuka109/mish/pull/375) correctly delivered a
  production-disabled Shared Rust shell-entry contract for that proposal. It
  never gained a production consumer and is retired with the proposal.
- [#373](https://github.com/Asuka109/mish/issues/373) records the hands-on
  rejection and the split-navigation reason. Its
  [PR #386](https://github.com/Asuka109/mish/pull/386) is closed and unmerged.
- [#374](https://github.com/Asuka109/mish/issues/374) is not planned because
  the same ownership conflict applies to an Apple persistent system shell.
- [#387](https://github.com/Asuka109/mish/issues/387) owns the repository
  cleanup and this durable decision record.

## Removed with the rejected direction

- the `mish-mobile-shell` workspace crate, DTOs, model tests, fixture, lockfile
  entry, and workspace registration;
- the debug-only Android `ShellPrototypeActivity` and manifest entry;
- the source-only Apple SwiftUI persistent-shell prototype;
- the live native-shell entry architecture contract and prototype validation
  guide; and
- shell-specific build, format, test, and boundary-check wiring.

The 2026-08-03 research report remains under `docs/research` as explicitly
superseded historical evidence, not as current architecture or a future plan.

## Boundaries that remain valid

Native and platform code remains authoritative for operating-system effects
that Web code cannot own, including Android VPN consent and foreground service,
TUN descriptors and socket protection, embedded Core lifecycle, platform
lifecycle callbacks, permissions, notifications required by the OS, and future
Apple Packet Tunnel work.

Those effects stay behind typed, permission-scoped, least-privilege adapters.
There is no arbitrary Web-to-Native script, message, URL-command, UI, or general
capability channel. The retained mobile capability-boundary check permits the
reviewed Settings and VPN/Core contracts while rejecting generic Native UI or
navigation escape hatches.

Desktop WebView, Browser Client, mobile product pages, accessibility behavior,
notification behavior, and the current Web navigation composition are not
changed by this decision. The decision also does not authorize a CSS imitation
of Apple Liquid Glass.

## Conditions for reconsideration

Do not reopen this direction from visual preference alone. Reconsideration
requires all of the following:

1. a materially different architecture with exactly one owner for the visible
   navigation hierarchy, child-route coverage, history, Back, overlays/sheets,
   and focus;
2. an explicit product decision and bounded Issue that explains why the current
   Web owner is no longer sufficient;
3. an exact runnable candidate proving the ownership model on the target
   platform, including deep links, child routes, cancelled and committed Back,
   recreation, accessibility, and overlay/focus behavior;
4. no arbitrary Web-to-Native capability channel and no duplicated product
   route or state store; and
5. an independently reversible migration with complete Desktop, Browser,
   mobile Web, and real platform-capability regression evidence plus explicit
   maintainer acceptance.
