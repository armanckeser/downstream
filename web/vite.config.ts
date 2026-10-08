import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@domain": path.join(here, "..", "domain") } },
  build: { outDir: path.join(here, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: { port: 5199, proxy: { "/api": process.env.DOWNSTREAM_API ?? "http://127.0.0.1:4317" } },
});
