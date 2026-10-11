import type {
  AppConfig,
  Definition,
  DownloadDonePayload,
  DownloadProgressPayload,
  DownloadVideoOpts,
  FileStatus,
  IpcChannel,
  IpcParams,
  IpcResult,
  ListShareResult,
  PickPreviewResult,
  SavedShare,
  SetConfigInput,
  ShareMeta,
  StatusQueryResult,
  UnlistenFn,
  VideoPreview,
} from "../../electron/shared/contract";

// 类型统一由 IPC 契约表提供，语义与旧 Tauri 版一致（字段 snake_case 原样透传）。
export type {
  AppConfig,
  Definition,
  DownloadDonePayload,
  DownloadProgressPayload,
  DownloadVideoOpts,
  FileState,
  FileStatus,
  ListShareResult,
  PickPreviewResult,
  PreviewTemplate,
  SavedShare,
  SetConfigInput,
  ShareItem,
  ShareItemType,
  ShareMeta,
  StatusQueryResult,
  UnlistenFn,
  VideoPreview,
} from "../../electron/shared/contract";

// ---- 传输层：经 preload 桥 window.fastcut 调用 main（Wave 3 接线） ----

function invoke<C extends IpcChannel>(channel: C, args?: IpcParams[C]): Promise<IpcResult[C]> {
  const bridge = window.fastcut;
  if (bridge === undefined || typeof bridge.invoke !== "function") {
    throw new Error(`fastcut bridge unavailable, cannot invoke "${channel}" (Wave 3)`);
  }
  return bridge.invoke(channel, args);
}

function listen<K extends "download-progress" | "download-done">(
  event: K,
  handler: (
    payload: K extends "download-progress" ? DownloadProgressPayload : DownloadDonePayload,
  ) => void,
): Promise<UnlistenFn> {
  const bridge = window.fastcut;
  if (bridge === undefined) {
    throw new Error(`fastcut bridge unavailable, cannot listen "${event}" (Wave 3)`);
  }
  if (event === "download-progress") {
    const off = bridge.onDownloadProgress(handler as (payload: DownloadProgressPayload) => void);
    return Promise.resolve(off);
  }
  const off = bridge.onDownloadDone(handler as (payload: DownloadDonePayload) => void);
  return Promise.resolve(off);
}

// ---- 命令封装 ----

export function listShares(): Promise<SavedShare[]> {
  return invoke("list_shares", {});
}

export function addShare(url: string, pwd?: string): Promise<SavedShare> {
  return invoke("add_share", { url, pwd });
}

export function renameShare(share_id: string, name: string): Promise<SavedShare> {
  return invoke("rename_share", { shareId: share_id, name });
}

export function removeShare(share_id: string): Promise<void> {
  return invoke("remove_share", { shareId: share_id });
}

export function getShareMeta(share_id: string, pwd?: string): Promise<ShareMeta> {
  return invoke("get_share_meta", { shareId: share_id, pwd });
}

export function listShare(
  share_id: string,
  parent_file_id: string,
  marker?: string,
  limit?: number,
  pwd?: string,
): Promise<ListShareResult> {
  return invoke("list_share", {
    shareId: share_id,
    parentFileId: parent_file_id,
    marker,
    limit,
    pwd,
  });
}

export async function getStatusBatch(
  share_id: string,
  file_ids: string[],
): Promise<StatusQueryResult> {
  const arr = await invoke("get_status_batch", {
    shareId: share_id,
    fileIds: file_ids,
  });
  const out = arr as StatusQueryResult;
  for (const s of arr) {
    out[s.file_id] = s;
  }
  return out;
}

export function videoPreview(
  share_id: string,
  drive_id: string,
  file_id: string,
  pwd?: string,
): Promise<VideoPreview[]> {
  return invoke("video_preview", {
    shareId: share_id,
    driveId: drive_id,
    fileId: file_id,
    pwd,
  });
}

export function pickPreviewUrl(
  share_id: string,
  drive_id: string,
  file_id: string,
  definition: Definition,
  pwd?: string,
): Promise<PickPreviewResult> {
  return invoke("pick_preview_url", {
    shareId: share_id,
    driveId: drive_id,
    fileId: file_id,
    definition,
    pwd,
  });
}

export function downloadVideo(opts: DownloadVideoOpts): Promise<string>;
export function downloadVideo(
  m3u8_url: string,
  share_id: string,
  file_id: string,
  file_name: string,
  template: string,
  sub_dir: string,
): Promise<string>;
export function downloadVideo(
  m3u8_url_or_opts: string | DownloadVideoOpts,
  share_id?: string,
  file_id?: string,
  file_name?: string,
  template?: string,
  sub_dir?: string,
): Promise<string> {
  if (typeof m3u8_url_or_opts === "object") {
    const o = m3u8_url_or_opts;
    return invoke("download_video", {
      m3u8Url: o.m3u8_url,
      shareId: o.share_id,
      fileId: o.file_id,
      fileName: o.file_name,
      template: o.template,
      subDir: o.sub_dir,
    });
  }
  return invoke("download_video", {
    m3u8Url: m3u8_url_or_opts,
    shareId: share_id ?? "",
    fileId: file_id ?? "",
    fileName: file_name ?? "",
    template: template ?? "",
    subDir: sub_dir ?? "",
  });
}

export function getConfig(): Promise<AppConfig> {
  return invoke("get_config", {});
}

export function setConfig(config: SetConfigInput): Promise<void> {
  // 命令顶层参数名为 config（camelCase 固定），嵌套结构体保持 snake_case。
  const inner: { target_dir?: string; definition?: string } = {};
  if (config.target_dir !== undefined) inner.target_dir = config.target_dir;
  // UI 侧命名 materialDir 优先，语义即 target_dir。
  if (config.materialDir !== undefined && config.materialDir !== null) {
    inner.target_dir = config.materialDir;
  }
  if (config.definition !== undefined) inner.definition = config.definition;
  return invoke("set_config", { config: inner });
}

export function pickFolder(): Promise<string | null> {
  return invoke("pick_folder", {});
}

export function getStatus(share_id: string, file_id: string): Promise<FileStatus> {
  return invoke("get_status", { shareId: share_id, fileId: file_id });
}

/**
 * 缩略图预取：把一批 fileId+远程 URL 交给 main，缺失才下载；
 * 返回命中的 fileId → 本地媒体 URL（失败项直接缺席，调用方回退远程 URL）。
 */
export function warmThumbnails(
  share_id: string,
  files: { fileId: string; url: string }[],
): Promise<Record<string, string>> {
  return invoke("thumbnail_warm", { shareId: share_id, files }).then((r) => r.cached);
}

/** 查单个缩略图本地缓存：命中返回媒体 URL，否则 null。 */
export function getLocalThumbnail(share_id: string, file_id: string): Promise<string | null> {
  return invoke("thumbnail_local", { shareId: share_id, fileId: file_id }).then(
    (r) => (r === null ? null : r.url),
  );
}

// ---- 事件订阅（主契约：返回 Promise<UnlistenFn>）----

export function onDownloadProgress(
  handler: (payload: DownloadProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen("download-progress", handler);
}

export function onDownloadDone(
  handler: (payload: DownloadDonePayload) => void,
): Promise<UnlistenFn> {
  return listen("download-done", handler);
}

// ---- 事件订阅（UI 侧同步别名：返回同步 unlisten 函数）----

export function onProgress(handler: (payload: DownloadProgressPayload) => void): () => void {
  let off: UnlistenFn | undefined;
  void listen("download-progress", handler)
    .then((fn) => {
      off = fn;
    })
    .catch(() => undefined);
  return () => {
    off?.();
  };
}

export function onDone(handler: (payload: DownloadDonePayload) => void): () => void {
  let off: UnlistenFn | undefined;
  void listen("download-done", handler)
    .then((fn) => {
      off = fn;
    })
    .catch(() => undefined);
  return () => {
    off?.();
  };
}
