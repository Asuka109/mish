import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";

import {
  browserClientUrlFromOutput,
  createTauriDevelopmentEnvironment,
  createTauriDevelopmentConfig,
  findAvailablePort,
  hostUrlOpenerCommand,
  isTauriDevelopmentStartupAbort,
  parseTauriDevelopmentArguments,
  resolveTauriDevelopmentExitCode,
} from "./tauri-dev.ts";
import type { DevelopmentMihomoSelection } from "./development-mihomo.ts";

const desktopConfig = JSON.parse(
  readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const desktopEnvironment = readFileSync(
  new URL("../apps/desktop/.env.development", import.meta.url),
  "utf8",
);
const desktopPackage = JSON.parse(
  readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
);
const desktopCargo = readFileSync(
  new URL("../apps/desktop/src-tauri/Cargo.toml", import.meta.url),
  "utf8",
);
const bridgeCargo = readFileSync(
  new URL("../crates/desktop-bridge/Cargo.toml", import.meta.url),
  "utf8",
);
const launcherSource = readFileSync(new URL("./tauri-dev.ts", import.meta.url), "utf8");

test("falls back when the preferred development port is occupied", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });

  try {
    const address = occupied.address();
    assert(address && typeof address === "object");
    assert((await findAvailablePort(address.port)) > address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("overrides Tauri with the selected Vite origin", () => {
  assert.deepEqual(JSON.parse(createTauriDevelopmentConfig("http://127.0.0.1:4174")), {
    build: { devUrl: "http://127.0.0.1:4174" },
  });
});

test("configures an isolated backend-free desktop demo", () => {
  assert.deepEqual(JSON.parse(createTauriDevelopmentConfig("http://127.0.0.1:4174", true)), {
    identifier: "com.asuka109.mish.demo",
    productName: "Mish Demo",
    build: {
      beforeDevCommand: "pnpm --dir ../.. --filter @mish/web dev:demo",
      devUrl: "http://127.0.0.1:4174",
    },
  });
});

test("forwards pnpm pass-through options to the Tauri CLI", () => {
  assert.deepEqual(parseTauriDevelopmentArguments(["--", "--no-watch"]), {
    application: [],
    demo: false,
    forwarded: ["--no-watch"],
    openBrowser: false,
    tartTunAcceptance: false,
  });
  assert.deepEqual(parseTauriDevelopmentArguments(["--demo", "--verbose"]), {
    application: [],
    demo: true,
    forwarded: ["--verbose"],
    openBrowser: false,
    tartTunAcceptance: false,
  });
});

test("separates the process-local DevTools flag from Tauri CLI options", () => {
  assert.deepEqual(parseTauriDevelopmentArguments(["--", "--devtools", "--no-watch"]), {
    application: ["--devtools"],
    demo: false,
    forwarded: ["--no-watch"],
    openBrowser: false,
    tartTunAcceptance: false,
  });
  assert.deepEqual(parseTauriDevelopmentArguments(["--devtools=true"]), {
    application: ["--devtools=true"],
    demo: false,
    forwarded: [],
    openBrowser: false,
    tartTunAcceptance: false,
  });
});

test("consumes the explicit Tart TUN acceptance opt-in without forwarding it", () => {
  assert.deepEqual(parseTauriDevelopmentArguments(["--tart-tun-acceptance", "--no-watch"]), {
    application: [],
    demo: false,
    forwarded: ["--no-watch"],
    openBrowser: false,
    tartTunAcceptance: true,
  });
  assert.equal(
    parseTauriDevelopmentArguments(["--demo", "--tart-tun-acceptance"]).tartTunAcceptance,
    true,
  );
});

test("consumes the opt-in Browser Client opener without forwarding it", () => {
  assert.deepEqual(parseTauriDevelopmentArguments(["--open", "--no-watch"]), {
    application: [],
    demo: false,
    forwarded: ["--no-watch"],
    openBrowser: true,
    tartTunAcceptance: false,
  });
});

test("keeps the desktop window trigger feature out of shipped commands", () => {
  assert.match(launcherSource, /--features", "development-core-host,development-window-trigger"/u);
  assert.match(desktopCargo, /default = \[\]/u);
  assert.match(
    desktopCargo,
    /development-window-trigger = \["mish-bridge\/development-window-trigger"\]/u,
  );
  assert.match(bridgeCargo, /development-window-trigger = \[\]/u);
  for (const command of [
    desktopPackage.scripts.build,
    desktopPackage.scripts["bundle:macos"],
    desktopPackage.scripts["bundle:macos:internal-tun-alpha"],
    desktopPackage.scripts["bundle:macos:alpha-ad-hoc"],
    desktopPackage.scripts["bundle:macos:production"],
    desktopPackage.scripts["bundle:macos:signed-direct"],
  ]) {
    assert.doesNotMatch(command, /development-window-trigger/u);
  }
});

test("uses the standard host URL opener without a shell", () => {
  const url = "http://127.0.0.1:6474/#token=" + "a".repeat(43);
  assert.deepEqual(hostUrlOpenerCommand("darwin", url), {
    arguments: [url],
    command: "open",
  });
  assert.deepEqual(hostUrlOpenerCommand("linux", url), {
    arguments: [url],
    command: "xdg-open",
  });
  assert.deepEqual(hostUrlOpenerCommand("win32", url), {
    arguments: ["/d", "/s", "/c", "start", "", url],
    command: "cmd.exe",
  });
});

test("opens only a complete stable Browser Client readiness line", () => {
  const token = "a".repeat(43);
  const url = `http://127.0.0.1:6474/#token=${token}`;
  assert.equal(browserClientUrlFromOutput(`building\nMish Browser Client URL: ${url}\n`), url);
  assert.equal(browserClientUrlFromOutput(`Mish Browser Client URL: ${url.slice(0, -1)}`), null);
  assert.equal(
    browserClientUrlFromOutput(`Mish Browser Client URL: http://localhost:6474/#token=${token}\n`),
    null,
  );
});

function developmentCore(
  binary: string,
  source: DevelopmentMihomoSelection["source"],
): DevelopmentMihomoSelection {
  return {
    binary,
    binarySha256: "a".repeat(64),
    source,
    version: "Mihomo Meta v1.19.29 darwin arm64 with fictional-go",
  };
}

test("preserves a verified explicit local Core override", () => {
  const invocation = parseTauriDevelopmentArguments([]);
  assert.deepEqual(
    createTauriDevelopmentEnvironment(
      {
        MISH_MIHOMO_BIN: "/synthetic/private/local-mihomo",
      },
      "http://127.0.0.1:4174",
      invocation,
      developmentCore("/synthetic/private/local-mihomo", "explicit-override"),
    ),
    {
      MISH_DEV_ORIGIN: "http://127.0.0.1:4174",
      MISH_DEVELOPMENT_CORE_SOURCE: "explicit-override",
      MISH_MIHOMO_BIN: "/synthetic/private/local-mihomo",
      MISH_WEB_PORT: "4174",
    },
  );
});

test("uses the repository pin only when no explicit override was selected", () => {
  const binary = "/synthetic/repository/.scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29";
  const environment = createTauriDevelopmentEnvironment(
    {},
    "http://127.0.0.1:4174",
    parseTauriDevelopmentArguments([]),
    developmentCore(binary, "repository-pin"),
  );
  assert.equal(environment.MISH_DEVELOPMENT_CORE_SOURCE, "repository-pin");
  assert.equal(environment.MISH_MIHOMO_BIN, binary);
});

test("keeps the backend-free demo independent from inherited Core state", () => {
  const environment = createTauriDevelopmentEnvironment(
    { MISH_MIHOMO_BIN: "/synthetic/private/missing-mihomo" },
    "http://127.0.0.1:4174",
    parseTauriDevelopmentArguments(["--demo"]),
    null,
  );
  assert.equal(environment.MISH_DESKTOP_DEMO, "1");
  assert.equal(environment.MISH_DEVELOPMENT_CORE_SOURCE, undefined);
  assert.equal(environment.MISH_MIHOMO_BIN, undefined);
});

test("keeps the checked-in main WebView Inspector configuration default-off", () => {
  const mainWindow = desktopConfig.app.windows.find(
    (window: { label?: string }) => window.label === "main",
  );
  assert(mainWindow);
  assert.equal(mainWindow.devtools, false);
});

test("enables detached DevTools only in tracked desktop development commands", () => {
  assert.equal(desktopEnvironment, "MISH_DEVTOOLS=1\n");
  assert.match(desktopPackage.scripts.dev, /--env-file=\.env\.development/u);
  assert.match(desktopPackage.scripts.demo, /--env-file=\.env\.development/u);
  assert.doesNotMatch(desktopPackage.scripts.build, /env-file|MISH_DEVTOOLS/u);
  assert.doesNotMatch(desktopPackage.scripts["bundle:macos"], /env-file|MISH_DEVTOOLS/u);
  assert.doesNotMatch(desktopPackage.scripts["bundle:macos:production"], /env-file|MISH_DEVTOOLS/u);
});

test("recognizes a native setup abort even when Tauri exits successfully", () => {
  assert.equal(
    isTauriDevelopmentStartupAbort(
      "Failed to setup app: error encountered during setup hook: native Quit menu item is unavailable",
    ),
    true,
  );
  assert.equal(isTauriDevelopmentStartupAbort("Tauri development server stopped"), false);
  assert.equal(
    isTauriDevelopmentStartupAbort(
      "Failed to setup app: thread caused non-unwinding panic. aborting.",
    ),
    true,
  );
  assert.equal(resolveTauriDevelopmentExitCode(0, null, true), 1);
});

test("propagates child exit failures and signals", () => {
  assert.equal(resolveTauriDevelopmentExitCode(2, null, false), 2);
  assert.equal(resolveTauriDevelopmentExitCode(null, "SIGTERM", false), 1);
  assert.equal(resolveTauriDevelopmentExitCode(null, null, false), 1);
});
