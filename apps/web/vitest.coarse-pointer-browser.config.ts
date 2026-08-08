import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    "import.meta.env.VITE_MISH_TEST_COARSE_POINTER": JSON.stringify("true"),
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
          hasTouch: true,
          reducedMotion: "reduce",
        },
      }),
    },
    include: [
      "src/platform/coarse-pointer-controls.browser.test.ts",
      "src/platform/responsive-shell.browser.test.ts",
    ],
  },
});
