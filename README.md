# Mish

Mish is a local traffic-management interface for Mihomo-compatible services.
The product surface is a TypeScript/React application with six navigable views:
Status, Routes, Profiles, Traffic, Events, and Settings.

The current application graph is intentionally small and explicit:

- shared contracts and operations live in `packages/contracts`;
- oRPC transport and bounded transcripts live in `packages/orpc-client`;
- domain lifecycle actors live in `packages/domain` and XState composition;
- TanStack Query owns server projections and `packages/ui-state` owns
  presentation state;
- Electron and React Native provide thin host seams around the same Web
  product, without duplicating product lifecycle or cache authority.

The browser product authenticates a session before rendering data projections.
Tests use credential-free contract fixtures, deterministic transcripts, and
replay. They do not claim real network, permission, VPN, TUN, or system-proxy
effects. The isolated `poc/` tree is admitted only by `pnpm poc:admission` and
is not part of the production workspace or runtime graph.

## Development

Use Node.js and pnpm from the repository manifest:

```sh
pnpm install --frozen-lockfile
pnpm check:pr
pnpm web:build
```

The focused host gates are `pnpm desktop:check` and `pnpm mobile:check`.
`pnpm desktop:bundle:fixture` creates a disposable, credential-free DMG
fixture; `pnpm mobile:android:build` produces the dual-ABI debug APK used by
the admission gate. These commands do not publish, sign, notarize, deploy, or
write to external services.

See [`docs/README.md`](docs/README.md) for the current architecture and
validation map, and [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution
rules.

## License

Mish-authored source is licensed under
[GPL-3.0-only](LICENSE). Direct dependency and asset notices are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
