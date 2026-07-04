import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Production build optimizations
  build: {
    // Disable source maps in production for smaller bundles
    sourcemap: false,
    // Optimize chunk splitting for better caching
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Keep CodeMirror in its own chunk
          if (id.includes("@codemirror/")) {
            return "codemirror";
          }
          if (id.includes("react-dom") || id.includes("node_modules/react/")) {
            return "react";
          }
        },
      },
    },
    // Use default Oxc minification (Vite 8 default)
    // Target modern browsers for smaller output
    target: "esnext",
  },
}));
