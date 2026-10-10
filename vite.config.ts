import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 2 + Vite + React.
export default defineConfig({
  clearScreen: false,
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
  },
});
