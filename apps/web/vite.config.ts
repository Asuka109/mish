import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 700,
  },
  plugins: [react(), tailwindcss()],
  publicDir: fileURLToPath(new URL("../../packages/brand-assets/public", import.meta.url)),
  server: {
    allowedHosts: ["terminal.local"],
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "**/*.browser.test.ts", "**/*.browser.test.tsx"],
    setupFiles: "./src/test/setup.ts",
  },
});
