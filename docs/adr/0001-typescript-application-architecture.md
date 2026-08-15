---
status: accepted
---

# Use oRPC, XState, and TanStack for the TypeScript application architecture

Mish will make one breaking application-architecture cutover before launch: shared contract-first oRPC replaces the custom JSON-RPC stack, XState v5 actors/statecharts own domain lifecycles and complex workflows, TanStack Query owns remote resource state, and a pinned minimal TanStack Store wrapper owns lightweight cross-component UI state. Web and Electron keep Base UI/shadcn headless primitives, React Native uses native primitives behind the Mish component layer, both share design tokens, and React local state remains appropriate for transient single-component state.

The oRPC seam must retain Mish's authentication, version negotiation, session generation, stale-response rejection, deadlines, message-size bounds, correlation, and reconnect recovery policies while preferring WebSocket/Event Iterator transports and allowing an Electron MessagePort adapter. Event Iterators feed the Query cache or XState actors rather than duplicating remote state into TanStack Store; `@mish/ui-state` may expose only pinned, compatibility-proven core Store APIs, including React Native/Hermes admission evidence.

The delivered architecture must not retain dual writes, old-protocol compatibility adapters, a Mish-owned general state-machine runtime, Zag, a second UI-machine runtime, long-term Rust parity mode, a Rust Core, or the Rust compilation toolchain. TypeScript/XState owns Core and domain logic; Kotlin, Swift, Objective-C, or another host-native adapter owns any irreducible platform capability, while bounded pre-cutover compatibility and admission proofs remain allowed only as temporary migration evidence.
