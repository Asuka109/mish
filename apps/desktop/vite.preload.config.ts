import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: false,
    target: "es2022",
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./src/preload.ts", import.meta.url)),
      external: ["electron"],
      output: {
        // Electron 43's sandbox executes preloads as plain JavaScript. The
        // authored source remains ESM, but the isolated runtime needs the
        // documented CommonJS require bridge for `electron`.
        format: "cjs",
        inlineDynamicImports: true,
        entryFileNames: "preload.mjs",
      },
    },
  },
});
