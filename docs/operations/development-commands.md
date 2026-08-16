# Development Commands

The root `package.json` is the command authority. The commands below are the
small set used by the final gates.

| Command                          | Purpose                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Install the locked TypeScript workspace                                                 |
| `pnpm check:pr`                  | Run admission, graph, POC isolation, CI, lint, format, type, test, docs, and host gates |
| `pnpm check:graph`               | Walk production entries and reject retired paths or duplicate authorities               |
| `pnpm poc:admission`             | Read-only, fail-closed check of the isolated POC tree                                   |
| `pnpm check:ci`                  | Validate the product, Electron, and RN workflow gates                                   |
| `pnpm web:build`                 | Build the Web renderer                                                                  |
| `pnpm desktop:check`             | Electron type check and tests                                                           |
| `pnpm desktop:bundle:fixture`    | Build and verify a disposable credential-free DMG fixture                               |
| `pnpm mobile:check`              | RN type check and tests                                                                 |
| `pnpm mobile:android:build`      | Build the dual-ABI Android debug APK                                                    |
| `pnpm test:transcript`           | Run domain, oRPC, and UI-state transcript tests                                         |
| `pnpm check:docs`                | Check Markdown links and tracker metadata                                               |

There are no commands for the retired native toolchain, compatibility bridge,
or product publication. The POC command never executes POC runtime code.
