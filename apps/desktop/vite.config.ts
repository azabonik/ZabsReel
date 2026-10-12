import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer build. `base: "./"` produces relative asset URLs so the built
// index.html loads correctly from the file:// protocol inside Electron, and
// from the web shell's server root (web/server.cjs).
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Developing against the web shell: run `npm run web -- --no-open` and the
    // dev page's /api calls (file picker, MCP config) reach it. changeOrigin
    // makes the Host header match the shell's loopback check.
    proxy: { "/api": { target: "http://127.0.0.1:4790", changeOrigin: true } },
  },
});
