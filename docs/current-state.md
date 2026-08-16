# Current Repository State

The repository is admitted as a TypeScript product graph with one shared
session composition:

```text
oRPC contracts
      -> OrpcSessionAuthority + WebSocket transport
      -> XState session/domain actors
      -> TanStack Query projections
      -> React pages and presentation Store
```

Electron and React Native consume the same contracts through thin host seams.
The Web route surface contains Status, Routes, Profiles, Traffic, Events, and
Settings. No host owns a second session, generation, stale-delivery, cache, or
business lifecycle authority.

## Current verification sources

| Area                     | Source of truth                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission and retirement | `scripts/check-typescript-cutover-admission.ts`, `scripts/check-production-retirement.ts`, and [`architecture/typescript-cutover-admission.md`](architecture/typescript-cutover-admission.md) |
| POC isolation            | `scripts/check-poc-admission.ts` and `pnpm poc:admission`                                                                                                                                     |
| Contracts and transport  | `packages/contracts`, `packages/orpc-client`, and transcript fixtures                                                                                                                         |
| Web composition          | `apps/web/src/main.tsx`, `apps/web/src/data/cutover-composition.tsx`, and `apps/web/src/pages/cutover-pages.tsx`                                                                              |
| Electron host            | `apps/desktop/src` and `apps/desktop/scripts/electron-fixture.ts`                                                                                                                             |
| RN host                  | `apps/mobile/src`, `apps/mobile/android`, and `apps/mobile/scripts`                                                                                                                           |
| CI                       | `.github/workflows/ci.yml` and `scripts/check-ci-workflow.ts`                                                                                                                                 |

## Evidence limits

The automated gates are credential-free and bounded. They prove graph shape,
contract behavior, privacy-safe transcripts, deterministic replay, host
security, and disposable packaging fixtures. They do not prove a real user
permission grant, VPN/TUN attachment, system proxy mutation, external network
availability, publication, signing, notarization, or deployment.

The `poc/` tree is read only by the isolated admission checker. It is not a
workspace member, production import, fallback, or runtime dependency.

Issue #91 was completed as historical contract evidence. Issue #94 was also
completed; neither is a current production dependency.

For commands and the review loop, see [`../development.md`](../development.md)
and [`README.md`](README.md).
