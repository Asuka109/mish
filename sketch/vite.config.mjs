import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(projectDirectory, "index.html"),
        profiles: path.resolve(projectDirectory, "profiles.html"),
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(projectDirectory, "src"),
    },
  },
});
