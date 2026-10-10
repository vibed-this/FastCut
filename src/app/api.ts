import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---- 基础类型（字段 snake_case 与 Rust 完全一致，原样透传） ----

export type Definition = "AUTO" | "HD" | "SD";

export interface SavedShare {
  share_id: string;
  url: string;
  name: string;
  pwd: string;
  added_at: string;
}

export interface ShareMeta {
  name: string;
}

export type ShareItemType = "file" | "folder";

export interface ShareItem {
  file_id: string;
  drive_id: string;
  name: string;
  type: ShareItemType;
  size?: number;
  category?: string;
  file_extension?: string;
}

export interface ListShareResult {
  items: ShareItem[];
  next_marker: string;
}

export type FileState = "saved" | "downloading" | "none";

export interface FileStatus {
  file_id: string;
  state: FileState;
  path?: string;
}

/** 后端返回的数组 + 按 file_id 索引的映射，一次返回同时满足两种消费方式。 */
export type StatusQueryResult = FileStatus[] & Record<string, FileStatus>;

export interface VideoPreview {
  template_id: string;
  template_name?: string;
  template_width?: number;
  template_height?: number;
  status?: string;
  preview_url?: string;
}

/** UI 侧别名：与 VideoPreview 同构。 */
export type PreviewTemplate = VideoPreview;

/** pick_preview_url 的返回：播放地址 + 实际命中的档（与 Rust PickPreviewResult 对应）。 */
export interface PickPreviewResult {
  url: string;
  template: string;
}

export interface AppConfig {
  target_dir?: string;
  definition: Definition;
}

/**
 * set_config 入参：兼容 UI 侧的 `materialDir` 写法，
 * 运行时统一翻译为后端的 `target_dir`。
 */
export interface SetConfigInput {
  target_dir?: string;
  materialDir?: string | null;
  definition?: string;
}

export interface DownloadVideoOpts {
  share_id: string;
  file_id: string;
  file_name: string;
  m3u8_url: string;
  template: string;
  sub_dir: string;
}

export interface DownloadProgressPayload {
  file_id: string;
  done: number;
  total: number;
}

export interface DownloadDonePayload {
  file_id: string;
  ok: boolean;
  path?: string;
  error?: string;
}

// ---- 命令封装 ----

export function listShares(): Promise<SavedShare[]> {
  return invoke<SavedShare[]>("list_shares");
}

export function addShare(url: string, pwd?: string): Promise<SavedShare> {
  return invoke<SavedShare>("add_share", { url, pwd });
}

export function renameShare(share_id: string, name: string): Promise<void> {
  return invoke<void>("rename_share", { shareId: share_id, name });
}

export function removeShare(share_id: string): Promise<void> {
  return invoke<void>("remove_share", { shareId: share_id });
}

export function getShareMeta(share_id: string, pwd?: string): Promise<ShareMeta> {
  return invoke<ShareMeta>("get_share_meta", { shareId: share_id, pwd });
}

export function listShare(
  share_id: string,
  parent_file_id: string,
  marker?: string,
  limit?: number,
  pwd?: string,
): Promise<ListShareResult> {
  return invoke<ListShareResult>("list_share", {
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
  const arr = await invoke<FileStatus[]>("get_status_batch", {
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
  return invoke<VideoPreview[]>("video_preview", {
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
  return invoke<PickPreviewResult>("pick_preview_url", {
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
    return invoke<string>("download_video", {
      m3u8Url: o.m3u8_url,
      shareId: o.share_id,
      fileId: o.file_id,
      fileName: o.file_name,
      template: o.template,
      subDir: o.sub_dir,
    });
  }
  return invoke<string>("download_video", {
    m3u8Url: m3u8_url_or_opts,
    shareId: share_id,
    fileId: file_id,
    fileName: file_name,
    template,
    subDir: sub_dir,
  });
}

export function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
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
  return invoke<void>("set_config", { config: inner });
}

export function pickFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

// ---- 事件订阅（主契约：返回 Promise<UnlistenFn>）----

export function onDownloadProgress(
  handler: (payload: DownloadProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgressPayload>("download-progress", (event) => {
    handler(event.payload);
  });
}

export function onDownloadDone(
  handler: (payload: DownloadDonePayload) => void,
): Promise<UnlistenFn> {
  return listen<DownloadDonePayload>("download-done", (event) => {
    handler(event.payload);
  });
}

// ---- 事件订阅（UI 侧同步别名：返回同步 unlisten 函数）----

export function onProgress(
  handler: (payload: DownloadProgressPayload) => void,
): () => void {
  let off: UnlistenFn | undefined;
  void listen<DownloadProgressPayload>("download-progress", (event) => {
    handler(event.payload);
  })
    .then((fn) => {
      off = fn;
    })
    .catch(() => undefined);
  return () => {
    off?.();
  };
}

export function onDone(
  handler: (payload: DownloadDonePayload) => void,
): () => void {
  let off: UnlistenFn | undefined;
  void listen<DownloadDonePayload>("download-done", (event) => {
    handler(event.payload);
  })
    .then((fn) => {
      off = fn;
    })
    .catch(() => undefined);
  return () => {
    off?.();
  };
}
