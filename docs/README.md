# Project Documentation

This directory contains the durable product, architecture, design-pattern, and
quality knowledge needed to evolve Mish without reconstructing past
decisions from chat history.

## Authority map

| Question                                                                    | Authoritative document                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Who is the product for, and what should it feel like?                       | [`../PRODUCT.md`](../PRODUCT.md)                                                                 |
| Which visual tokens and styling rules are binding?                          | [`../DESIGN.md`](../DESIGN.md)                                                                   |
| How should the Status experience behave?                                    | [`product/status-experience.md`](product/status-experience.md)                                   |
| What are the implementation-ready product requirements and release slices?  | [`product/prds/README.md`](product/prds/README.md)                                               |
| What belongs in the web app, desktop bridge, Tauri shell, or native layer?  | [`architecture/frontend-platform-boundary.md`](architecture/frontend-platform-boundary.md)       |
| How does the desktop bundle and authenticated local startup work?           | [`architecture/desktop-bootstrap.md`](architecture/desktop-bootstrap.md)                         |
| How do the desktop bridge, Controller adapter, and Mihomo process interact? | [`architecture/mihomo-controller-integration.md`](architecture/mihomo-controller-integration.md) |
| How are profile sources preflighted, redacted, and stored?                  | [`architecture/profile-domain.md`](architecture/profile-domain.md)                               |
| Where do Status values come from and how are they derived?                  | [`architecture/status-data-contracts.md`](architecture/status-data-contracts.md)                 |
| How do detailed Traffic snapshots, reconnects, and local Closed work?       | [`architecture/traffic-data-contracts.md`](architecture/traffic-data-contracts.md)               |
| How should recurring UI structures be composed?                             | [`design/component-patterns.md`](design/component-patterns.md)                                   |
| What is real, mocked, verified, or still pending?                           | [`quality/prototype-validation.md`](quality/prototype-validation.md)                             |
| How is the production Web foundation run and validated?                     | [`quality/production-web-validation.md`](quality/production-web-validation.md)                   |
| How is the native macOS sidebar material validated?                         | [`quality/native-sidebar-validation.md`](quality/native-sidebar-validation.md)                   |

## Supporting material

- [`research/`](research/) contains source-backed upstream, platform, licensing,
  and visual-reference research.
- [`research/clash-verge-rev-deep-walkthrough-2026-07-18.md`](research/clash-verge-rev-deep-walkthrough-2026-07-18.md)
  records the installed Clash Verge Rev 2.5.1 Computer Use coverage matrix,
  safe secondary surfaces, scroll evidence, a profile-backed runtime follow-up,
  and the remaining proxy-provider and tray blockers.
- [`../.claude/plans/development-plan.md`](../.claude/plans/development-plan.md)
  is the Chinese implementation plan. It is useful for sequencing work but is
  not the authority for current product or design behavior.
- [`../sketch/`](../sketch/) is the interactive reference implementation. Its
  mock data must not be mistaken for a production API contract.
- [`../apps/web/`](../apps/web/) is the production Mish browser/WebView entry.
  Browser startup remains fixture-backed; desktop startup explicitly composes
  the RPC adapter and is not evidence of Mihomo controller reconciliation.
- [`../apps/desktop/`](../apps/desktop/) is the thin Tauri shell. It owns only
  the desktop window, embedded asset startup, desktop-bridge composition, and the
  private bootstrap seam.

## Maintenance rules

1. Put a decision in the narrowest authoritative document and link to it from
   related documents instead of copying the full rule.
2. Update the relevant contract in the same change as a product, architecture,
   or design decision.
3. Mark assumptions, mock-only behavior, and unresolved choices explicitly.
4. Record source-backed investigation under `research/`; move only the durable
   conclusion into a contract document.
5. Keep repository documentation in English. Claude Code plan files are the
   only planned exception.
