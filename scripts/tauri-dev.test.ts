import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";

import {
  createTauriDevelopmentConfig,
  findAvailablePort,
  isTauriDevelopmentStartupAbort,
  parseTauriDevelopmentArguments,
  resolveTauriDevelopmentExitCode,
} from "./tauri-dev.ts";

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
    tartTunAcceptance: false,
  });
  assert.deepEqual(parseTauriDevelopmentArguments(["--demo", "--verbose"]), {
    application: [],
    demo: true,
    forwarded: ["--verbose"],
    tartTunAcceptance: false,
  });
});

test("separates the process-local DevTools flag from Tauri CLI options", () => {
  assert.deepEqual(parseTauriDevelopmentArguments(["--", "--devtools", "--no-watch"]), {
    application: ["--devtools"],
    demo: false,
    forwarded: ["--no-watch"],
    tartTunAcceptance: false,
  });
  assert.deepEqual(parseTauriDevelopmentArguments(["--devtools=true"]), {
    application: ["--devtools=true"],
    demo: false,
    forwarded: [],
    tartTunAcceptance: false,
  });
});

test("consumes the explicit Tart TUN acceptance opt-in without forwarding it", () => {
  assert.deepEqual(parseTauriDevelopmentArguments(["--tart-tun-acceptance", "--no-watch"]), {
    application: [],
    demo: false,
    forwarded: ["--no-watch"],
    tartTunAcceptance: true,
  });
  assert.equal(
    parseTauriDevelopmentArguments(["--demo", "--tart-tun-acceptance"]).tartTunAcceptance,
    true,
  );
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
