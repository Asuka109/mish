import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        main: fileURLToPath(new URL("./src/main.ts", import.meta.url)),
        renderer: fileURLToPath(new URL("./src/renderer.tsx", import.meta.url)),
      },
      external: ["electron", /^node:/u],
      output: {
        format: "es",
        entryFileNames: (chunk) => (chunk.name === "main" ? "main.mjs" : `${chunk.name}.mjs`),
        chunkFileNames: "chunks/[name]-[hash].mjs",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
