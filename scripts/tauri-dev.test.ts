import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
  createTauriDevelopmentConfig,
  findAvailablePort,
  isTauriDevelopmentStartupAbort,
  parseTauriDevelopmentArguments,
  resolveTauriDevelopmentExitCode,
} from "./tauri-dev.ts";

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
    demo: false,
    forwarded: ["--no-watch"],
  });
  assert.deepEqual(parseTauriDevelopmentArguments(["--demo", "--verbose"]), {
    demo: true,
    forwarded: ["--verbose"],
  });
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
