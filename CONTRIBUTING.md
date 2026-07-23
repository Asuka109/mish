# Contributing to Mish

Mish is an experimental, cross-platform client with network and operating-system
effects. Contributions should be narrow, evidence-backed, and explicit about
the platform boundary they change.

## Before you start

1. Search existing issues and pull requests for overlapping work.
2. Read [`PRODUCT.md`](PRODUCT.md) and the task-oriented
   [documentation index](docs/README.md).
3. For interface work, follow [`DESIGN.md`](DESIGN.md).
4. For runtime, packaging, or native work, read the owning architecture and
   quality documents before editing.
5. Do not use real profiles, subscription addresses, credentials, private node
   names, or host network state as fixtures or evidence.

For a behavior change or material bug fix, open an issue before substantial
work unless a maintainer has already approved the scope. For potentially
sensitive reports, contact a maintainer before posting details publicly.

## Development

The supported baseline is Node.js 24, pnpm 11.13.1, and stable Rust.

```sh
pnpm install --frozen-lockfile
pnpm check:pr
```

Use [`bootstrap.md`](bootstrap.md) for workstation setup and
[`docs/operations/development-commands.md`](docs/operations/development-commands.md)
for focused commands. Tests must not silently enable System Proxy, TUN, VPN
services, listeners, administrator authorization, or other host mutations.

## Pull requests

Keep each pull request focused on one observable outcome. Include:

- the problem and intended behavior;
- affected platforms and explicit non-goals;
- executed checks and their results;
- fixture, screenshot, or device evidence when the change requires it;
- privacy, security, packaging, localization, and accessibility effects; and
- remaining limitations or follow-up work.

Repository documentation, code comments, commit messages, and pull-request
descriptions should be in clear English. Product copy must update both English
and Simplified Chinese dictionaries and regenerate the typed localization
output.

Do not claim production readiness, official status, platform support, legal
compliance, or compatibility beyond the repository's current validation
evidence. Do not add telemetry, hosted dependencies, proprietary components,
third-party artwork, provider branding, or privileged behavior without an
explicit review of the applicable technical and license boundaries.

## Licensing and provenance

By submitting a contribution, you confirm that you have the right to submit it
and agree to license it under GPL-3.0-only. Copyright remains with each
contributor unless a separate signed agreement expressly assigns it. Mish
currently has no Contributor License Agreement, copyright-assignment agreement,
or Developer Certificate of Origin workflow. The maintainer receives no broader
copyright license to another contributor's work than any other GPL recipient.

GPL-covered copies of Mish may be sold or otherwise distributed commercially,
but distribution must continue to follow the GPL. No maintainer or contributor
may relicense another contributor's GPL-covered work under incompatible or
proprietary terms without separate permission from the relevant copyright
holder.

Third-party material retains its own license. Do not submit content that you do
not have the right to contribute under terms compatible with the repository and
its distribution. Preserve upstream notices and record the exact source,
version, license, and modification status for copied or derived material. A
maintainer may request provenance or licensing clarification before accepting a
contribution.

## Generative AI-assisted contributions

This section adapts the contribution standards in
[Mihomo's published generative AI content policy](https://github.com/MetaCubeX/Meta-Docs/commit/a51a2482c65f4b1a7056a370f9a1d6575cb55744).

For issues, use concrete, reproducible, human-verified evidence. Mihomo's
[issue-submission guidance](https://github.com/MetaCubeX/mihomo/issues/1049) is
a useful reference for report quality, but Mish issues must concern this
repository and follow its own templates.

For pull requests:

- **Responsibility does not change.** Contributors are responsible for the
  content, quality, safety, and licensing of their submissions whether or not
  they use a generative AI tool.
- **Complete human review is required.** Contributions that have not been fully
  inspected, tested, and revised as needed by the contributor will not be
  accepted.
- **Generated conclusions are not technical evidence.** Claims produced by a
  tool must be supported by source material, repository evidence, reproduction,
  or tests that a reviewer can independently verify.
- **Third-party rights must be documented.** Do not present generated or
  third-party material as original work. Before submitting pre-existing code or
  other copyrighted material contained in tool output, confirm that you have
  permission to use, modify, and contribute it. Include the source, applicable
  license terms, notices, and attribution with the contribution.
