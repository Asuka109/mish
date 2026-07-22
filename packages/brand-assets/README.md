# Mish brand assets

This package is the single source of truth for Mish production image assets.

- `public/brand/mish-icon-outline.svg` is the canonical Mish mark geometry.
- The other light and dark SVGs in `public/brand/` are synchronized from that
  geometry by `scripts/generate-brand-assets.ts`.
- PNG files in `public/brand/` are generated from their corresponding SVGs.
- `generated/tauri/` contains desktop, Android, iOS, and Windows variants
  derived from the generated 1024 px light application icon.
- `public/onboarding/` contains centralized non-brand artwork. Vite serves the
  entire `public/` directory as the Web app's public directory.

The desktop status bar reads generated 36 px raw RGBA data directly from this
package and displays it at the native 18 pt menu-bar size on Retina screens.
macOS recolors that monochrome template for light and dark menu bars.
The explicit light and dark status bar SVG and PNG files remain available for
previewing and non-template consumers.

Android launcher files under `apps/mobile/src-tauri/gen/android/` are the only
production image copies outside this package. Gradle requires those paths, so
the generation script overwrites them from `generated/tauri/`; they must not be
edited directly. Images in `sketch/` and `.agents/skills/` are design references
or agent documentation rather than application resources.

The onboarding cover uses [“Retro beige computer model centered on a minimalist
background”](https://unsplash.com/photos/SgeRfp8xdfo) by
[Petri R](https://unsplash.com/@petrirh1), downloaded and optimized under the
[Unsplash License](https://unsplash.com/license).

After changing the canonical outline or a brand style, regenerate all light and
dark SVG/PNG outputs, platform icons, and checked-in Android launcher resources
from the repository root:

```sh
pnpm generate:brand
```

The script fingerprints the generated 1024 px source before invoking Tauri, so
unchanged runs remain byte-for-byte stable. Use `pnpm generate:brand
--force-tauri` only when the platform icon tool itself must be rerun.
