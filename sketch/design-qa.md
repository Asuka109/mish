# Prototype Design QA

The durable validation scope, mock boundary, required commands, and native-shell
gate are maintained in
[`../docs/quality/prototype-validation.md`](../docs/quality/prototype-validation.md).
Do not extend this file into a second design-history log.

## Current reference

- Product behavior: [`../docs/product/status-experience.md`](../docs/product/status-experience.md)
- Visual contract: [`../DESIGN.md`](../DESIGN.md)
- Component anatomy: [`../docs/design/component-patterns.md`](../docs/design/component-patterns.md)
- Data semantics: [`../docs/architecture/status-data-contracts.md`](../docs/architecture/status-data-contracts.md)
- Verification viewport: 1024×768 plus the narrow stacking breakpoint

## Latest focused verification

The sidebar `ProxyControlButton` default and hover layers now crossfade without
translation. Repeated hover at 1.5× device pixel ratio no longer produces the
intermittent one-pixel line beneath the Wi-Fi icon. The production build remains
the required regression check after further visual changes.
