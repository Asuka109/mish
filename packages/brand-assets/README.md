# Mish brand assets

This package is the single source of truth for Mish production image assets.

- `public/brand/mish-icon-outline.svg` is the canonical Mish mark geometry.
- The other light and dark SVGs in `public/brand/` are synchronized from that
  geometry by `scripts/generate-brand-assets.ts`.
- PNG files in `public/brand/` are generated from their corresponding SVGs.
- `public/onboarding/` contains centralized non-brand artwork. Vite serves the
  entire `public/` directory as the Web app's public directory.

The desktop status bar reads generated 36 px raw RGBA template masks directly
from this package and displays them at the native 18 pt menu-bar size on Retina
screens. `mish-status-bar-active.rgba` is full alpha; the inactive mask uses a
documented 45% alpha while preserving the same geometry. Both masks have only
black RGB data and transparent alpha, so macOS recolors them for light, dark,
and highlighted menu-bar appearances. The black template input is internal and
is not a public appearance asset.

Public previews use unambiguous names: `mish-status-bar-full` is white at full
prominence, and `mish-status-bar-inactive` is gray. Each is generated as SVG
and 18 px / 36 px (`@2x`) PNG output for previewing or non-template consumers.

Native shells consume the public assets through their own build inputs; this
package does not generate or export host-toolchain output. Images in
`.agents/skills/` are design references or agent documentation rather than
application resources.

The onboarding cover uses [“Retro beige computer model centered on a minimalist
background”](https://unsplash.com/photos/SgeRfp8xdfo) by
[Petri R](https://unsplash.com/@petrirh1), downloaded and optimized under the
[Unsplash License](https://unsplash.com/license).

After changing the canonical outline or a brand style, regenerate the checked-in
light and dark SVG/PNG outputs from the repository root:

```sh
pnpm generate:brand
```

The script is deterministic and does not invoke a host platform tool or require
credentials.
