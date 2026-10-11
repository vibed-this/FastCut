/**
 * FastCut IPC 契约（Wave 1）。
 *
 * main / preload / renderer 三方共用的唯一事实来源。
 * 类型语义照抄 `src/app/api.ts` 的同名接口：
 * - invoke 顶层参数名沿用 camelCase（如 shareId / fileIds / m3u8Url）；
 * - 嵌套结构体与后端字段保持 snake_case（如 share_id / target_dir）。
 *
 * Channel 名与旧 Tauri 命令名一一对应（14 个）+ 缩略图缓存 2 个；事件 2 个。
 * Wave 3 在 main 侧按此表注册 `ipcMain.handle`，preload 原样透出。
 */

/** 清晰度档位。 */
export type Definition = "AUTO" | "HD" | "SD";

/** 已保存的分享链接（与落盘 schema/序列化一致：无 pwd 写 null，added_at 为秒级整数）。 */
export interface SavedShare {
  share_id: string;
  url: string;
  name: string;
  pwd: string | null;
  added_at: number;
}

/** 分享元信息。 */
export interface ShareMeta {
  name: string;
}

/** 分享条目类型。 */
export type ShareItemType = "file" | "folder";

/** 分享目录条目（`thumbnail` 为服务端快照，需 `list_by_share` 带缩略图参数才返回）。 */
export interface ShareItem {
  file_id: string;
  drive_id: string;
  name: string;
  type: ShareItemType;
  size?: number;
  category?: string;
  file_extension?: string;
  thumbnail?: string;
}

/** list_share 返回：分页条目 + 下一页 marker。 */
export interface ListShareResult {
  items: ShareItem[];
  next_marker: string;
}

/** 文件本地落盘状态。 */
export type FileState = "saved" | "downloading" | "none";

/** 单文件状态。 */
export interface FileStatus {
  file_id: string;
  state: FileState;
  path?: string;
}

/** 后端返回的数组 + 按 file_id 索引的映射，一次返回同时满足两种消费方式。 */
export type StatusQueryResult = FileStatus[] & Record<string, FileStatus>;

/** 视频预览档位。 */
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

/** pick_preview_url 的返回：播放地址 + 实际命中的档。 */
export interface PickPreviewResult {
  url: string;
  template: string;
}

/** 应用配置。 */
export interface AppConfig {
  target_dir?: string;
  definition: Definition;
}

/**
 * set_config 入参：兼容 UI 侧的 `materialDir` 写法，
 * 运行时统一翻译为后端的 `target_dir`。
 * store 侧为合并语义：未传的字段保持原值（见 store.setConfig），非全量覆盖。
 */
export interface SetConfigInput {
  target_dir?: string;
  materialDir?: string | null;
  definition?: string;
}

/** download_video 的对象式入参（与各位置参数一一对应）。 */
export interface DownloadVideoOpts {
  share_id: string;
  file_id: string;
  file_name: string;
  m3u8_url: string;
  template: string;
  sub_dir: string;
}

/** download-progress 事件载荷。 */
export interface DownloadProgressPayload {
  file_id: string;
  done: number;
  total: number;
}

/** download-done 事件载荷。 */
export interface DownloadDonePayload {
  file_id: string;
  ok: boolean;
  path?: string;
  error?: string;
}

// ---- Channel 名（14 个，与旧 Tauri 命令名一致） ----

/** IPC channel 名联合类型。 */
export type IpcChannel =
  | "list_shares"
  | "add_share"
  | "rename_share"
  | "remove_share"
  | "get_config"
  | "set_config"
  | "pick_folder"
  | "get_status"
  | "get_status_batch"
  | "list_share"
  | "video_preview"
  | "pick_preview_url"
  | "get_share_meta"
  | "download_video"
  | "thumbnail_warm"
  | "thumbnail_local";

/** 各 channel 的 invoke 入参（顶层 camelCase）。 */
export interface IpcParams {
  list_shares: Record<string, never>;
  add_share: { url: string; pwd?: string };
  rename_share: { shareId: string; name: string };
  remove_share: { shareId: string };
  get_config: Record<string, never>;
  set_config: { config: { target_dir?: string; definition?: string } };
  pick_folder: Record<string, never>;
  get_status: { shareId: string; fileId: string };
  get_status_batch: { shareId: string; fileIds: string[] };
  list_share: {
    shareId: string;
    parentFileId: string;
    marker?: string;
    limit?: number;
    pwd?: string;
  };
  video_preview: { shareId: string; driveId: string; fileId: string; pwd?: string };
  pick_preview_url: {
    shareId: string;
    driveId: string;
    fileId: string;
    definition: Definition;
    pwd?: string;
  };
  get_share_meta: { shareId: string; pwd?: string };
  download_video: {
    m3u8Url: string;
    shareId: string;
    fileId: string;
    fileName: string;
    template: string;
    subDir: string;
  };
  /** 缩略图预取：缺失项后台下载，返回命中的 fileId → 本地媒体 URL。 */
  thumbnail_warm: { shareId: string; files: { fileId: string; url: string }[] };
  /** 查单个缩略图本地缓存：命中返回媒体 URL，否则 null。 */
  thumbnail_local: { shareId: string; fileId: string };
}

/** 各 channel 的 invoke 返回（rename_share 以旧 Rust `Result<SavedShare>` 为准，返回更新后的分享）。 */
export interface IpcResult {
  list_shares: SavedShare[];
  add_share: SavedShare;
  rename_share: SavedShare;
  remove_share: void;
  get_config: AppConfig;
  set_config: void;
  pick_folder: string | null;
  get_status: FileStatus;
  get_status_batch: FileStatus[];
  list_share: ListShareResult;
  video_preview: VideoPreview[];
  pick_preview_url: PickPreviewResult;
  get_share_meta: ShareMeta;
  download_video: string;
  thumbnail_warm: { cached: Record<string, string> };
  thumbnail_local: { url: string } | null;
}

// ---- 事件名（2 个） ----

/** IPC 事件名联合类型。 */
export type IpcEvent = "download-progress" | "download-done";

/** 各事件的载荷。 */
export interface IpcEventPayload {
  "download-progress": DownloadProgressPayload;
  "download-done": DownloadDonePayload;
}

// ---- preload 桥接面（renderer 经 window.fastcut 调用） ----

/** 组件卸载时调用的取消订阅函数。 */
export type UnlistenFn = () => void;

/** preload 通过 contextBridge 暴露给 renderer 的桥接面。 */
export interface FastcutBridge {
  /** 通用调用：channel 名 + 入参，返回对应结果。 */
  invoke<C extends IpcChannel>(channel: C, args?: IpcParams[C]): Promise<IpcResult[C]>;
  /** 订阅下载进度事件。 */
  onDownloadProgress(handler: (payload: DownloadProgressPayload) => void): UnlistenFn;
  /** 订阅下载完成事件。 */
  onDownloadDone(handler: (payload: DownloadDonePayload) => void): UnlistenFn;
  /**
   * 原生拖出：Renderer 磁贴 `ondragstart` 里 `preventDefault` 后调用，
   * 经 `ondragstart` 消息转 main `webContents.startDrag({ file })`，
   * OS 侧等价于从 Finder/资源管理器拖出真实文件（仅本地已保存文件可用）。
   */
  startFileDrag(filePath: string): void;
}

declare global {
  interface Window {
    fastcut: FastcutBridge;
  }
}
