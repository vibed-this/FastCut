import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";

import type { SavedShare as IpcSavedShare } from "../shared/contract.js";
import { downloadVideo, isDownloading } from "./downloader.js";
import {
  get_share_meta,
  list_share,
  pick_preview_url,
  video_preview,
} from "./share-api.js";
import {
  addShare,
  getConfig,
  getStatus,
  getStatusBatch,
  listShares,
  removeShare,
  renameShare,
  setConfig,
  setIsDownloadingProvider,
  type SavedShare as StoreSavedShare,
} from "./store.js";

/** 当前主窗口（activate 重建后更新，handler 经 getWin 懒取，注册一次即可）。 */
let mainWin: BrowserWindow | null = null;

function getWin(): BrowserWindow {
  const win = mainWin ?? BrowserWindow.getAllWindows()[0];
  if (win === undefined) throw new Error("主窗口不存在");
  return win;
}

/** store 落盘形（pwd 可选）→ IPC 契约形（无 pwd 即 null，与序列化一致）。 */
function toIpcShare(s: StoreSavedShare): IpcSavedShare {
  return { ...s, pwd: s.pwd ?? null };
}

/** 错误统一转字符串抛给 renderer（保持旧 Tauri "Err(String)" 语义）。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 注册全部 14 个 `ipcMain.handle`（channel/入参/返回见 `electron/shared/contract.ts`）。
 * 只调用一次（重复注册会抛）；窗口引用经 `getWin()` 懒取。
 */
function registerIpcHandlers(userDataDir: string): void {
  ipcMain.handle("list_shares", async () => {
    try {
      return (await listShares(userDataDir)).map(toIpcShare);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("add_share", async (_e, args: { url: string; pwd?: string }) => {
    try {
      return toIpcShare(await addShare(userDataDir, args.url, args.pwd));
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("rename_share", async (_e, args: { shareId: string; name: string }) => {
    try {
      return toIpcShare(await renameShare(userDataDir, args.shareId, args.name));
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("remove_share", async (_e, args: { shareId: string }) => {
    try {
      await removeShare(userDataDir, args.shareId);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("get_config", async () => {
    try {
      return await getConfig(userDataDir);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle(
    "set_config",
    async (_e, args: { config: { target_dir?: string; definition?: string } }) => {
      try {
        // store 侧合并语义：未传字段保持原值。
        await setConfig(userDataDir, args.config);
      } catch (e) {
        throw new Error(errMsg(e));
      }
    },
  );

  ipcMain.handle("pick_folder", async () => {
    try {
      const ret = await dialog.showOpenDialog(getWin(), {
        properties: ["openDirectory"],
      });
      if (ret.canceled) return null;
      return ret.filePaths[0] ?? null;
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("get_status", async (_e, args: { shareId: string; fileId: string }) => {
    try {
      return await getStatus(userDataDir, args.shareId, args.fileId);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle(
    "get_status_batch",
    async (_e, args: { shareId: string; fileIds: string[] }) => {
      try {
        return await getStatusBatch(userDataDir, args.shareId, args.fileIds);
      } catch (e) {
        throw new Error(errMsg(e));
      }
    },
  );

  ipcMain.handle(
    "list_share",
    async (
      _e,
      args: { shareId: string; parentFileId: string; marker?: string; limit?: number; pwd?: string },
    ) => {
      try {
        return await list_share(args.shareId, args.parentFileId, args.marker, args.limit, args.pwd);
      } catch (e) {
        throw new Error(errMsg(e));
      }
    },
  );

  ipcMain.handle(
    "video_preview",
    async (_e, args: { shareId: string; driveId: string; fileId: string; pwd?: string }) => {
      try {
        // 旧 Rust command 固定传 None 作 pwd，此处逐字保留：入参的 pwd 兼容接收但不透传。
        return await video_preview(args.shareId, args.driveId, args.fileId);
      } catch (e) {
        throw new Error(errMsg(e));
      }
    },
  );

  ipcMain.handle(
    "pick_preview_url",
    async (
      _e,
      args: { shareId: string; driveId: string; fileId: string; definition: string; pwd?: string },
    ) => {
      try {
        return await pick_preview_url(
          args.shareId,
          args.driveId,
          args.fileId,
          args.definition,
          args.pwd,
        );
      } catch (e) {
        throw new Error(errMsg(e));
      }
    },
  );

  ipcMain.handle("get_share_meta", async (_e, args: { shareId: string; pwd?: string }) => {
    try {
      return await get_share_meta(args.shareId, args.pwd);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle(
    "download_video",
    async (
      _e,
      args: {
        m3u8Url: string;
        shareId: string;
        fileId: string;
        fileName: string;
        template: string;
        subDir: string;
      },
    ) => {
      try {
        const win = getWin();
        return await downloadVideo({
          m3u8Url: args.m3u8Url,
          shareId: args.shareId,
          fileId: args.fileId,
          fileName: args.fileName,
          template: args.template,
          subDir: args.subDir,
          userDataDir,
          emit: (event, payload) => {
            win.webContents.send(event, payload);
          },
        });
      } catch (e) {
        throw new Error(errMsg(e));
      }
    },
  );
}

/** 创建主窗口：1440×900，最小 1000×650。 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWin = win;

  if (process.env["ELECTRON_RENDERER_URL"] !== undefined) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  const userDataDir = app.getPath("userData");
  // store 的 isDownloading 判别由 downloader 提供（store 永不 import downloader，无环）。
  setIsDownloadingProvider(isDownloading);
  registerIpcHandlers(userDataDir);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
