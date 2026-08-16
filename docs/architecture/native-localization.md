# Localization Boundary

Localization is a TypeScript presentation concern. Generated locale data is
owned by the Web package and consumed by React; a host seam must not own
product copy or lifecycle state. `pnpm check:i18n` verifies the generated
contract and `pnpm check:format` keeps locale sources deterministic.
