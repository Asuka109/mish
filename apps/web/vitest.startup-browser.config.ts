import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  publicDir: fileURLToPath(new URL("../../packages/brand-assets/public", import.meta.url)),
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright({
        contextOptions: {
          reducedMotion: "reduce",
        },
      }),
    },
    include: ["src/appearance-bootstrap.browser.test.ts"],
  },
});
