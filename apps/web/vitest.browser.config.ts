import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: fileURLToPath(new URL("../../packages/brand-assets/public", import.meta.url)),
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright(),
    },
    exclude: ["src/appearance-bootstrap.browser.test.ts"],
    include: ["src/**/*.browser.test.{ts,tsx}"],
  },
});
