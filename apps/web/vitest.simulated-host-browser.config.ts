import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  optimizeDeps: {
    entries: ["src/system-tests/simulated-host.browser.test.tsx"],
  },
  plugins: [react(), tailwindcss()],
  publicDir: fileURLToPath(new URL("../../packages/brand-assets/public", import.meta.url)),
  test: {
    browser: {
      api: {
        host: "127.0.0.1",
        port: 63315,
        strictPort: true,
      },
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright(),
    },
    globalSetup: "./src/system-tests/simulated-host-global-setup.ts",
    include: ["src/system-tests/simulated-host.browser.test.tsx"],
  },
});
