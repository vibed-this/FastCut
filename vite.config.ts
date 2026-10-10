import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Electron 下 renderer 配置以 electron.vite.config.ts 为准；此文件仅供 vitest 复用。
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
