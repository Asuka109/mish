# Mish Product

## Purpose

Mish gives people a calm, inspectable control surface for a locally managed
Mihomo-compatible service. The product emphasizes status, route selection,
profile context, traffic observations, events, and settings without exposing
transport details as product state.

## Product surface

The Web application exposes six primary destinations:

1. Status — current session and service health.
2. Routes — route observations and policy context.
3. Profiles — profile metadata and selection context.
4. Traffic — bounded traffic observations.
5. Events — ordered event observations.
6. Settings — client preferences and connection settings.

Each page reads a typed oRPC projection through the shared XState session actor
and TanStack Query. Local filters, tabs, and disclosure controls remain
presentation state. No page owns a second session, generation, stale-delivery,
or lifecycle authority.

## Boundaries

The production graph is TypeScript-only for product logic. Electron and React
Native are host seams; they do not become alternate product authorities. The
runtime never imports the isolated `poc/` tree. Contract fixtures and bounded
transcripts cover privacy, ordering, replay, and failure rendering without
claiming real network, permission, VPN, TUN, or system effects.

The interface should remain restrained, dense, keyboard-operable, and legible
without color alone. See [`DESIGN.md`](DESIGN.md) and
[`docs/product/status-experience.md`](docs/product/status-experience.md) for
the visual contract.
