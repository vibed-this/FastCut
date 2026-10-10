import { contextBridge, ipcRenderer } from "electron";
import type {
  DownloadDonePayload,
  DownloadProgressPayload,
  FastcutBridge,
} from "../shared/contract";

const bridge: FastcutBridge = {
  invoke: (channel, args) => ipcRenderer.invoke(channel, args),
  onDownloadProgress: (handler: (payload: DownloadProgressPayload) => void) => {
    const fn = (_e: unknown, payload: DownloadProgressPayload): void => {
      handler(payload);
    };
    ipcRenderer.on("download-progress", fn);
    return () => {
      ipcRenderer.removeListener("download-progress", fn);
    };
  },
  onDownloadDone: (handler: (payload: DownloadDonePayload) => void) => {
    const fn = (_e: unknown, payload: DownloadDonePayload): void => {
      handler(payload);
    };
    ipcRenderer.on("download-done", fn);
    return () => {
      ipcRenderer.removeListener("download-done", fn);
    };
  },
};

contextBridge.exposeInMainWorld("fastcut", bridge);
