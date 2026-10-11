import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol } from "electron";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { AddCollectionInput, Collection as IpcCollection } from "../shared/contract.js";
import { downloadVideo, downloadXhsDirect, isDownloading } from "./downloader.js";
import { fsList, fsMkdir, fsMove, fsRemove, fsRename } from "./localfs.js";
import { warmLocalVideoThumbnails } from "./local-thumb.js";
import { XhsClient } from "./xhs-client.js";
import {
  get_share_meta,
  list_share,
  pick_preview_url,
  video_preview,
} from "./share-api.js";
import {
  clearShareThumbnails,
  localThumbnail,
  pruneCache,
  warmThumbnails,
} from "./thumbnail-cache.js";
import {
  addCollection,
  getConfig,
  getStatus,
  getStatusBatch,
  listCollections,
  removeCollection,
  renameCollection,
  setConfig,
  setIsDownloadingProvider,
  type Collection as StoreCollection,
} from "./store.js";

/** 当前主窗口（activate 重建后更新，handler 经 getWin 懒取，注册一次即可）。 */
let mainWin: BrowserWindow | null = null;

function getWin(): BrowserWindow {
  const win = mainWin ?? BrowserWindow.getAllWindows()[0];
  if (win === undefined) throw new Error("主窗口不存在");
  return win;
}

/** store 形 → IPC 契约形（alipan 无 pwd 即 null，与落盘序列化一致）。 */
function toIpcCollection(s: StoreCollection): IpcCollection {
  if (s.kind === "alipan" && s.pwd === undefined) return { ...s, pwd: null };
  return { ...s };
}

/** 错误统一转字符串抛给 renderer（保持旧 "Err(String)" 语义）。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function requireTargetDir(userDataDir: string): Promise<string> {
  const config = await getConfig(userDataDir);
  const dir = config.target_dir?.trim() ?? "";
  if (dir === "") throw new Error("未配置目标文件夹，请先在设置页选择下载目录");
  return dir;
}

/**
 * 注册全部 `ipcMain.handle`（channel/入参/返回见 `electron/shared/contract.ts`）。
 * 只调用一次（重复注册会抛）；窗口引用经 `getWin()` 懒取。
 */
function registerIpcHandlers(userDataDir: string): void {
  ipcMain.handle("collection_list", async () => {
    try {
      return (await listCollections(userDataDir)).map(toIpcCollection);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("collection_add", async (_e, args: AddCollectionInput) => {
    try {
      return toIpcCollection(await addCollection(userDataDir, args));
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("collection_rename", async (_e, args: { id: string; name: string }) => {
    try {
      return toIpcCollection(await renameCollection(userDataDir, args.id, args.name));
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("collection_remove", async (_e, args: { id: string }) => {
    try {
      const removed = await removeCollection(userDataDir, args.id);
      // alipan 合集删除即清其缩略图缓存（best-effort，不影响删除结果）；
      // xiaohongshu 磁盘文件夹已在 store 层删除。
      if (removed.kind === "alipan") {
        await clearShareThumbnails(userDataDir, removed.share_id ?? removed.id);
      }
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("fs_list", async (_e, args: { relDir?: string }) => {
    try {
      const targetDir = await requireTargetDir(userDataDir);
      return await fsList(targetDir, args.relDir ?? "");
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("fs_mkdir", async (_e, args: { relDir: string }) => {
    try {
      const targetDir = await requireTargetDir(userDataDir);
      await fsMkdir(targetDir, args.relDir);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("fs_rename", async (_e, args: { relPath: string; name: string }) => {
    try {
      const targetDir = await requireTargetDir(userDataDir);
      await fsRename(targetDir, args.relPath, args.name);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("fs_move", async (_e, args: { relPath: string; destDir: string }) => {
    try {
      const targetDir = await requireTargetDir(userDataDir);
      await fsMove(targetDir, args.relPath, args.destDir);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("fs_remove", async (_e, args: { relPath: string }) => {
    try {
      const targetDir = await requireTargetDir(userDataDir);
      await fsRemove(targetDir, args.relPath);
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
        // 旧 command 固定传 None 作 pwd，此处保留：入参的 pwd 兼容接收但不透传。
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

  ipcMain.handle(
    "thumbnail_warm",
    async (_e, args: { shareId: string; files: { fileId: string; url: string }[] }) => {
      try {
        // Electron net 栈抓取（走系统代理），失败项跳过不抛
        const cached = await warmThumbnails(userDataDir, args.shareId, args.files, (url) =>
          net.fetch(url),
        );
        return { cached };
      } catch (e) {
        throw new Error(errMsg(e));
      }
    },
  );

  ipcMain.handle("thumbnail_local", async (_e, args: { shareId: string; fileId: string }) => {
    try {
      const url = await localThumbnail(userDataDir, args.shareId, args.fileId);
      return url === null ? null : { url };
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("thumbnail_local_warm", async (_e, args: { files: string[] }) => {
    try {
      const targetDir = await requireTargetDir(userDataDir);
      const { cached } = await warmLocalVideoThumbnails(
        userDataDir,
        targetDir,
        Array.isArray(args.files) ? args.files : [],
      );
      return { cached };
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle("xhs_parse", async (_e, args: { url: string }) => {
    try {
      const raw = args.url?.trim() ?? "";
      if (raw === "") throw new Error("链接不能为空");
      if (!raw.includes("xiaohongshu.com") && !raw.includes("xhslink.com")) {
        throw new Error("仅支持小红书链接（xiaohongshu.com / xhslink.com）");
      }
      return await new XhsClient().parse(raw);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  });

  ipcMain.handle(
    "xhs_import",
    async (
      _e,
      args: { url: string; collectionId: string; subDir?: string; fileName?: string },
    ) => {
      try {
        const raw = args.url?.trim() ?? "";
        if (raw === "") throw new Error("链接不能为空");
        const collectionId = args.collectionId?.trim() ?? "";
        if (collectionId === "") throw new Error("合集不能为空");
        const parsed = await new XhsClient().parse(raw);
        // 由合集 id 查 relDir：调用方传的 subDir 为相对 target_dir 的完整路径（合集根即其 relDir）；
        // 缺省则落到合集根目录。合集不存在或非 xiaohongshu 直接报错，不静默另建目录。
        const collections = await listCollections(userDataDir);
        const coll = collections.find((c) => c.id === collectionId);
        if (coll === undefined) throw new Error("合集不存在");
        if (coll.kind !== "xiaohongshu" || coll.relDir === undefined || coll.relDir.trim() === "") {
          throw new Error("仅小红书合集支持导入");
        }
        const sub = (args.subDir ?? "").trim();
        const relDir = sub === "" ? coll.relDir : sub.startsWith(coll.relDir) ? sub : `${coll.relDir}/${sub}`;
        const win = getWin();
        return await downloadXhsDirect({
          downloadUrl: parsed.downloadUrl,
          collectionId,
          relDir,
          fileName: args.fileName ?? parsed.title,
          title: parsed.title,
          noteId: parsed.noteId,
          author: parsed.author,
          cover: parsed.cover,
          sourceUrl: raw,
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

  /**
   * 原生拖出：Renderer 已保存磁贴 `ondragstart`（已 `preventDefault`）后发来本地绝对路径，
   * 此处调 `event.sender.startDrag({ file, icon })`，OS 侧等价于从 Finder/资源管理器拖出文件，
   * 可直接丢到 NLE 时间线 / Finder / 桌面。仅接受已存在的绝对路径文件；macOS icon 不能为空，
   * 首选该文件的系统图标，失败回退应用图标。
   */
  ipcMain.on("ondragstart", (event, filePath: unknown) => {
    try {
      // 仅接受已存在的本地绝对路径（相对路径/空串一律拒绝）。
      if (typeof filePath !== "string" || !isAbsolute(filePath) || !existsSync(filePath)) {
        return;
      }
      const abs = filePath;
      void app
        .getFileIcon(abs)
        .catch(() => nativeImage.createFromPath(join(app.getAppPath(), "build", "icon.png")))
        .then((icon) => {
          const finalIcon = !icon.isEmpty()
            ? icon
            : nativeImage.createFromPath(join(app.getAppPath(), "build", "icon.png"));
          event.sender.startDrag({ file: abs, icon: finalIcon });
        })
        .catch(() => undefined);
    } catch {
      // best-effort：拖出失败不抛回 renderer
    }
  });
}

/** 创建主窗口：1440×900，最小 1000×650。 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
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

/**
 * 本地媒体协议：已保存文件直接播本地落盘 mp4，不走远端。
 * `media://file/<encodeURI 绝对路径>` → 本地文件流（range 由 net.fetch 透传，支持拖动）。
 * 注册须在 app ready 之前。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: "media", privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } },
]);

void app.whenReady().then(() => {
  const userDataDir = app.getPath("userData");
  protocol.handle("media", (req) => {
    const prefix = "media://file";
    if (!req.url.startsWith(prefix)) {
      return new Response("bad media url", { status: 400 });
    }
    return net.fetch(`file://${req.url.slice(prefix.length)}`);
  });
  // store 的 isDownloading 判别由 downloader 提供（store 永不 import downloader，无环）。
  setIsDownloadingProvider(isDownloading);
  registerIpcHandlers(userDataDir);
  // 启动时清一次过期缩略图缓存（best-effort，不阻塞建窗）
  void pruneCache(userDataDir).catch(() => undefined);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
