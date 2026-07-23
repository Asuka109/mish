# Public-Release Documentation and Compliance Review

This review records the material public-facing findings for the documentation
PR prepared from `origin/main` at `cbe281c` on 2026-07-23. It is an engineering
audit, not legal advice. The macOS packaging-readiness audit was still active
when this review was written, so release claims must be reconciled with its
final findings before publication.

## Findings and dispositions

| Surface                       | Finding                                                                                                                                                                                                                                                                                                                  | Disposition                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public positioning            | The prior README accurately described prototypes but did not lead with the absence of a stable release or distinguish test artifacts from production distribution strongly enough.                                                                                                                                       | Rewritten as an evidence-bounded landing page. Stable-release, official-client, hosted-service, commercial-support, and production-readiness implications are expressly excluded.                                 |
| Platform support              | macOS development and test packaging exist; Android is a lifecycle and Core-identity prototype; iOS is architecture-only; Windows and Linux have no supported package.                                                                                                                                                   | Preserved as a target-by-target evidence table. Claims link to existing quality documents.                                                                                                                        |
| Packaging dependency          | A separate macOS packaging-readiness audit is active. The latest [`main` packaging run for `cbe281c`](https://github.com/Asuka109/mish/actions/runs/29992900635) failed before either hosted runner started because GitHub reported an account billing or spending-limit block; it produced no current package evidence. | README and this review mark public distribution as pending final reconciliation. No release date, artifact availability, or readiness claim was added.                                                            |
| Project license text          | `LICENSE` contained the GPLv3 terms in a reformatted 232-line presentation rather than the canonical 674-line FSF plain text, despite the license text's verbatim-copy requirement.                                                                                                                                      | Restore the canonical GPLv3 plain text without changing the repository's `GPL-3.0-only` choice.                                                                                                                   |
| Package metadata              | The Cargo workspace declared `GPL-3.0-only`, and every Mish Cargo package inherited it. npm workspace manifests did not declare a license field.                                                                                                                                                                         | Add `GPL-3.0-only` to every private Mish npm workspace manifest and enforce both ecosystems in `check:public-release`.                                                                                            |
| Packaged legal files          | The macOS bundle carried `LICENSE` and `THIRD_PARTY_NOTICES.md`; Android had no equivalent resource declaration. Privacy and disclaimer documents did not exist.                                                                                                                                                         | Package `LICENSE`, `THIRD_PARTY_NOTICES.md`, `PRIVACY.md`, and `DISCLAIMER.md` for desktop and mobile configurations and verify the macOS copy byte-for-byte.                                                     |
| In-app legal access           | Legal files are bundle resources, but the current product has no reviewed About or legal-notices view.                                                                                                                                                                                                                   | Leave the interface unchanged in this documentation task. Maintainer and counsel must decide whether and how packaged applications expose copyright, warranty, source, and third-party notices before release.    |
| Mihomo attribution            | The existing notice pinned Mihomo v1.19.29, its exact commit, license, and corresponding source, and stated non-affiliation.                                                                                                                                                                                             | Preserve and expand the notice with the upstream naming request and clear separation between Mish and Mihomo.                                                                                                     |
| Web and native dependencies   | The notice did not describe material bundled UI/runtime dependencies or distinguish them from Mish-authored GPL source.                                                                                                                                                                                                  | Add source and license references for the material direct dependencies and identify lockfiles as the exact version inventory. Do not claim that this high-level notice is a complete binary license bundle.       |
| Highcharts                    | `highcharts@13.0.0` is bundled in the Web application. Its package metadata points to Highsoft's separate license, and the repository contains no evidence of a commercial/OEM grant or GPL-compatible exception.                                                                                                        | Disclose the separate terms. Treat public binary distribution as blocked until the maintainer and qualified counsel confirm compatible rights or engineering replaces the dependency. No license is inferred.     |
| Rust dependency metadata      | Registry metadata includes varied permissive and weak-copyleft licenses. The development-only `bbolt-rs` manifest does not declare a license identifier.                                                                                                                                                                 | Keep exact versions in `Cargo.lock`; require a generated, reviewed binary license inventory before public distribution. The undeclared development dependency is a review item, not silently treated as licensed. |
| Mobile Core notices           | Android Mobile Core evidence records Mihomo source identity, checksums, a notice, and an SPDX SBOM, but many SBOM dependency license fields remain `NOASSERTION`.                                                                                                                                                        | Preserve the evidence and require license-field reconciliation before distributing a production Mobile Core binary. Do not describe the current SBOM as complete license clearance.                               |
| High-level privacy claim      | The prior README stated that runtime assets ship locally. Default service icons actually load from `registry.npmmirror.com`, and desktop service monitors make direct requests to configured endpoints.                                                                                                                  | Correct the README and document current storage, probes, remote icons, profile/provider activity, exports, and deletion in `PRIVACY.md`.                                                                          |
| Telemetry and hosted services | No Mish telemetry, analytics, crash reporter, hosted account/control plane, or automatic updater is configured. Mihomo and user configuration can still make network requests.                                                                                                                                           | State the bounded current behavior without promising that the complete dependency graph or future versions never communicate.                                                                                     |
| Artwork                       | The Mish wordmark and generated platform icons are repository-owned production assets. The onboarding cover is an Unsplash work by Petri R and was previously attributed only in the asset-package README.                                                                                                               | Reuse only the repository wordmark in the README and add the onboarding artwork credit and license link to the third-party notice. No screenshot or placeholder was added.                                        |
| Icons                         | The interface bundles Phosphor and Lucide icon code and requests default service icons from `remixicon@4.9.1` on npmmirror. The npm metadata reports Apache-2.0, while the upstream `v4.9.1` tag currently contains a custom Remix Icon License v1.0 that warns of possible strong-copyleft incompatibility.             | Add source/term references and disclose the remote request. Require the maintainer and counsel to reconcile the exact applicable terms or replace the remote icon source before distribution.                     |
| Public prose and UI copy      | The scan found no circumvention-oriented language, claim of official status, paid plan, warranty, hosted network service, or universal legal compliance in product copy. “Subscription” describes user-supplied profile sources rather than a Mish commercial offering.                                                  | Retain neutral technical terminology. Add automated checks for the most important non-affiliation, release-status, platform, and service-boundary claims.                                                         |
| Geographic fixtures           | Demo and test data include neutral city/airport identifiers, language samples, and service names. One preserved upstream UI research note records the territory labels visible in that upstream product.                                                                                                                 | Retain the fixtures and sourced research history. They test Unicode, localization, routing, and layout behavior and do not express a political position. No historical material was removed or silently reframed. |
| Sensitive examples            | Tests use reserved `.invalid` domains, loopback addresses, synthetic labels, and fake credentials. Public guidance already prohibits real profiles, URLs, labels, tokens, and screenshots.                                                                                                                               | Retain fixtures and repeat the prohibition in README, CONTRIBUTING, SECURITY, and PRIVACY.                                                                                                                        |
| Community documents           | The repository lacked contribution and private vulnerability-reporting guidance. It also lacked an enforceable Code of Conduct process or named moderation contact.                                                                                                                                                      | Add factual `CONTRIBUTING.md` and `SECURITY.md`. Do not add a ceremonial Code of Conduct, CLA, DCO, support SLA, or moderation promise without maintainer policy.                                                 |
| Vulnerability contact         | GitHub private vulnerability reporting is not currently verified for the repository, and no monitored private security contact is published.                                                                                                                                                                             | Do not invent a contact or promise. `SECURITY.md` requires the maintainer to enable a private channel before publication and gives a non-sensitive fallback only.                                                 |
| Duplicate credits             | A separate CREDITS or ACKNOWLEDGEMENTS file would duplicate the third-party notice and dependency manifests.                                                                                                                                                                                                             | Keep attribution in one reviewed `THIRD_PARTY_NOTICES.md` surface.                                                                                                                                                |
| Jurisdiction-specific claims  | The repository contains no evidence supporting a universal privacy, cybersecurity, distribution, or mainland-China compliance conclusion.                                                                                                                                                                                | Make no such claim. Release territories, local licensing, data-handling notices, and platform-store obligations remain maintainer/counsel decisions using current primary sources.                                |

## Automated controls

`pnpm check:public-release` now verifies:

- required public and packaged legal resources;
- the canonical GPLv3 license-text digest;
- `GPL-3.0-only` consistency across Mish npm and Cargo manifests;
- the pinned Mihomo version, commit, source, license, and non-affiliation notice;
- disclosure of material direct dependencies, artwork, remote icons, and the
  unresolved Highcharts license boundary; and
- conservative README claims for release status, platform support, hosted
  services, and packaging reconciliation.

`pnpm check:docs` runs the public-release check after validating local Markdown
links.

## Primary sources checked

- [Free Software Foundation GPLv3 text](https://www.gnu.org/licenses/gpl-3.0.html.en)
  and [SPDX `GPL-3.0-only`](https://spdx.org/licenses/GPL-3.0-only.html);
- [Mihomo v1.19.29 source](https://github.com/MetaCubeX/mihomo/tree/v1.19.29),
  [license](https://github.com/MetaCubeX/mihomo/blob/v1.19.29/LICENSE), and
  upstream README naming request;
- [Highsoft license terms](https://www.highcharts.com/license);
- [Remix Icon v4.9.1 license](https://github.com/Remix-Design/RemixIcon/blob/v4.9.1/License)
  and the `remixicon@4.9.1` npm metadata;
- [Unsplash License](https://unsplash.com/license); and
- [Tauri macOS signing and notarization guidance](https://v2.tauri.app/distribute/sign/macos/).

No jurisdiction-specific legal conclusion was needed to describe repository
behavior. Accordingly, this review does not make a mainland-China privacy,
cybersecurity, licensing, or distribution claim. Any future concrete claim must
be checked against current primary government or regulator sources and reviewed
by qualified counsel.

## Decisions required before public distribution

1. Reconcile this documentation with the completed packaging-readiness audit.
2. Confirm Highcharts distribution rights and GPL compatibility, or replace it
   with a dependency whose terms match the intended distribution.
3. Reconcile the `remixicon@4.9.1` npm metadata and tagged-source license, or
   remove the remote icon dependency.
4. Generate and review complete production license/notice inventories for the
   Web bundle, Rust application, pinned Mihomo binary, and Mobile Core, including
   all required license texts and SBOM fields.
5. Decide how installed applications expose source, license, warranty, privacy,
   and third-party notices.
6. Decide release territories, signing identity, support/contact policy,
   vulnerability-response ownership and private reporting channel, and whether
   remote service icons remain enabled by default.
7. Obtain qualified legal review for distribution obligations and any
   jurisdiction- or store-specific statements. Do not infer approval from this
   engineering audit.
