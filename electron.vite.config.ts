import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Electron + Vite + React：renderer 沿用根目录 index.html 与 src/。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: "electron/main/index.ts" },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: "electron/preload/index.ts" },
    },
  },
  renderer: {
    root: ".",
    plugins: [react()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "es2021",
      rollupOptions: { input: "./index.html" },
    },
  },
});
