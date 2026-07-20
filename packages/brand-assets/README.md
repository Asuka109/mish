# Mish brand assets

This package is the single source of truth for Mish logos and application icons.

- `public/` contains browser-ready assets. Vite serves this directory as the Web
  app's public directory.
- `generated/tauri/` contains desktop, Android, iOS, and Windows icon variants
  derived from `public/brand/mish-app-icon.png`.
- The desktop and mobile Tauri configurations reference this package instead of
  keeping independent icon copies.

After changing the source application icon, regenerate every derived icon and
the checked-in Android launcher resources from the repository root:

```sh
pnpm generate:brand
```
