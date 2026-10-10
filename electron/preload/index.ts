import { contextBridge } from "electron";
import type { FastcutBridge } from "../shared/contract";

// Wave 3 实现：按 electron/shared/contract.ts 用 ipcRenderer 接线
// invoke / onDownloadProgress / onDownloadDone，当前仅占位保证空窗可启动。
const bridge: FastcutBridge = {
  invoke: (_channel, _args) => {
    throw new Error("fastcut bridge not implemented yet (Wave 3)");
  },
  onDownloadProgress: (_handler) => {
    throw new Error("fastcut bridge not implemented yet (Wave 3)");
  },
  onDownloadDone: (_handler) => {
    throw new Error("fastcut bridge not implemented yet (Wave 3)");
  },
};

contextBridge.exposeInMainWorld("fastcut", bridge);
