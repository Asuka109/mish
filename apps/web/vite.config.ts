import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const configuredDevelopmentPort = Number.parseInt(process.env.MISH_WEB_PORT ?? "", 10);
const hasConfiguredDevelopmentPort = Number.isInteger(configuredDevelopmentPort);
const appearanceBootstrapPath = fileURLToPath(
  new URL("./appearance-bootstrap.js", import.meta.url),
);
const indexPath = fileURLToPath(new URL("./index.html", import.meta.url));

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      input: {
        appearanceBootstrap: appearanceBootstrapPath,
        index: indexPath,
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "appearanceBootstrap"
            ? "appearance-bootstrap.js"
            : "assets/[name]-[hash].js",
      },
    },
  },
  plugins: [react(), tailwindcss()],
  publicDir: fileURLToPath(new URL("../../packages/brand-assets/public", import.meta.url)),
  server: {
    allowedHosts: ["terminal.local"],
    host: "127.0.0.1",
    port: hasConfiguredDevelopmentPort ? configuredDevelopmentPort : 4173,
    strictPort: hasConfiguredDevelopmentPort,
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "**/*.browser.test.ts", "**/*.browser.test.tsx"],
    maxWorkers: 4,
    setupFiles: "./src/test/setup.ts",
  },
});
