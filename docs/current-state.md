# Current Repository State

This is the short entry path for repository state. It deliberately contains no
review SHA, refresh date, test count, CI result, or copied platform capability
matrix. Those facts age independently and belong in repository-derived checks,
dated quality checkpoints, or the owning domain contract.

## How to read a claim

- **Durable contract:** intended ownership, safety, or compatibility behavior.
  The narrow architecture or operations document is authoritative.
- **Dated checkpoint:** evidence observed at one named commit and date. It stays
  historical; later CI cannot repair a missing or failed historical gate.
- **Generated or read-back evidence:** facts derived from checked repository
  metadata or an explicit external read-back. Ordinary documentation checks use
  only checked-in inputs and never require GitHub access or a token.

The maintenance rules and bounded tracker model are defined in
[`documentation-evidence-contract.md`](architecture/documentation-evidence-contract.md).
The latest retained historical integration record is
[`current-state-checkpoint-2026-08-09.md`](quality/current-state-checkpoint-2026-08-09.md).
It is not promoted to current truth by this link.

## Authority map

| Question                                   | Read this authority                                                                                                                                                                       | Verify from                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Cross-platform product and state ownership | [`cross-platform-product-authority.md`](architecture/cross-platform-product-authority.md), [`runtime-state-ownership.md`](architecture/runtime-state-ownership.md)                        | Domain tests and `pnpm check:docs`                           |
| High-risk lifecycle adoption               | [`state-machine-kernel.md`](architecture/state-machine-kernel.md), [`state-machine-registry.json`](architecture/state-machine-registry.json)                                              | Registry check and owning domain tests                       |
| Desktop bridge and startup                 | [`bridge-protocol-contract.md`](architecture/bridge-protocol-contract.md), [`desktop-bootstrap.md`](architecture/desktop-bootstrap.md)                                                    | Generated protocol check and bridge tests                    |
| Ordered Web RPC snapshots                  | [`rpc-session-authority.md`](architecture/rpc-session-authority.md)                                                                                                                       | RPC authority tests, Web consumer tests, and repository gate |
| Android and mobile runtime                 | [`mobile-runtime-integration.md`](architecture/mobile-runtime-integration.md), [`android-vpn-service.md`](operations/android-vpn-service.md)                                              | Mobile boundary checks and named device evidence             |
| macOS TUN, packaging, and release trust    | [`macos-tun-helper.md`](architecture/macos-tun-helper.md), [`macos-packaging.md`](operations/macos-packaging.md), [`trusted-release-boundary.md`](operations/trusted-release-boundary.md) | Target-specific quality records and release-policy checks    |
| Updater behavior                           | [`updater-contract.md`](architecture/updater-contract.md)                                                                                                                                 | Updater contract fixtures and tests                          |

Code, tests, checked manifests, and CI describe implementation at a revision.
The documents above describe durable intent and evidence limits. If they
disagree, record the mismatch in the owning domain instead of copying a new
"current" fact into this page.

## Tracker-aware maintenance

Canonical Issue references are classified in
[`documentation-tracker-registry.json`](architecture/documentation-tracker-registry.json).
The offline documentation gate rejects unclassified references, duplicate
entries, a closed Issue classified as future work, and superseded references
that lack explicit decision context. Refreshing the checked-in read-back is a
separate maintainer action; the ordinary gate does not contact GitHub.
