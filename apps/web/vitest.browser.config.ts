import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  optimizeDeps: {
    entries: ["src/**/*.browser.test.{ts,tsx}"],
  },
  plugins: [react(), tailwindcss()],
  publicDir: fileURLToPath(new URL("../../packages/brand-assets/public", import.meta.url)),
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright({
        contextOptions: {
          colorScheme: "light",
          contrast: "no-preference",
          forcedColors: "none",
          hasTouch: false,
          reducedMotion: "no-preference",
        },
      }),
    },
    fileParallelism: false,
    exclude: [
      "src/appearance-bootstrap.browser.test.ts",
      "src/system-tests/**/*.browser.test.{ts,tsx}",
    ],
    include: ["src/**/*.browser.test.{ts,tsx}"],
    setupFiles: ["src/test/browser-environment.ts"],
  },
});
