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
      // sandbox:true 下 preload 必须为 CJS（package.json type:module 会使默认输出 es/.mjs，
      // 裸 import 进 sandbox 会报 Unable to load preload script）。
      lib: { entry: "electron/preload/index.ts", formats: ["cjs"] },
    },
  },
  renderer: {
    root: ".",
    plugins: [react()],
    build: {
      // 输出用 electron-vite 默认 out/renderer（与 main/preload 统一进 out/；
      // 旧 dist/ 输出会导致 prod loadFile 空白页，且与 builder 输出目录撞名）。
      target: "es2021",
      rollupOptions: { input: "./index.html" },
    },
  },
});
