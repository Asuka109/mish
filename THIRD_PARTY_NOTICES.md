# Third-Party Notices

Mish is independent software. It is not affiliated with, endorsed by, or an
official client of any project or service named below. Mish-authored source is
licensed under GPL-3.0-only; third-party software, artwork, icons, names, and
trademarks retain their own licenses.

The authoritative dependency versions are the TypeScript package manifests and
`pnpm-lock.yaml`. There is no second native package graph in this repository.

## Material application dependencies

| Project                                                   | Use                             | License or terms |
| --------------------------------------------------------- | ------------------------------- | ---------------- |
| [React](https://github.com/facebook/react)                | Web and host UI runtime         | MIT              |
| [React Router](https://github.com/remix-run/react-router) | Product navigation              | MIT              |
| [Base UI](https://github.com/mui/base-ui)                 | Accessible interface primitives | MIT              |
| [Phosphor Icons](https://github.com/phosphor-icons/react) | Interface icons                 | MIT              |
| [Lucide](https://github.com/lucide-icons/lucide)          | Interface icons                 | ISC              |
| [TanStack Query](https://github.com/TanStack/query)       | Server projection cache         | MIT              |
| [XState](https://github.com/statelyai/xstate)             | Domain lifecycle actors         | MIT              |
| [oRPC](https://orpc.unnoq.com/)                           | Typed request/response boundary | MIT              |
| [Electron](https://github.com/electron/electron)          | Desktop host seam               | MIT              |
| [React Native](https://github.com/facebook/react-native)  | Mobile host seam                | MIT              |

Exact transitive notices should be generated from the lockfile when a
distribution artifact is intentionally reviewed. CUT-06 does not publish,
sign, notarize, deploy, or claim distribution readiness.

## Mihomo naming

Mihomo is named only to identify the compatible service and its public
contracts. Mish does not operate hosted proxy or VPN services, sell
subscriptions, or provide network endpoints. User-configured connections may
make their own network requests; the fixture and replay gates do not.

## Icons and assets

Mish brand files live under [`packages/brand-assets`](packages/brand-assets).
Bundled service icons and their source/license records are kept beside that
package. Built-in assets are served locally; a user-selected remote icon is a
separate browser request and is outside the deterministic fixture gates.
