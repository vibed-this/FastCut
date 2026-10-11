/**
 * FastCut IPC 契约。
 *
 * main / preload / renderer 三方共用的唯一事实来源。
 * 类型语义：
 * - invoke 顶层参数名沿用 camelCase（如 shareId / fileIds / m3u8Url）；
 * - 嵌套结构体与后端字段保持 snake_case（如 share_id / target_dir）。
 *
 * Channel 名与旧 Tauri 命令名一一对应 + 缩略图缓存 2 个 + 合集 4 个 + 本地文件 5 个；事件 2 个。
 * main 侧按此表注册 `ipcMain.handle`，preload 原样透出。
 */

/** 清晰度档位。 */
export type Definition = "AUTO" | "HD" | "SD";

/** 合集种类：alipan 为分享链接合集，xiaohongshu 为本地落盘合集。 */
export type CollectionKind = "alipan" | "xiaohongshu";

/**
 * 合集。
 * - alipan：`id` 复用 `share_id`，带 `url`（`pwd` 无值时为 null）；
 * - xiaohongshu：`id` 为 `xhs_<短id>`，`relDir` 为相对 `target_dir` 的
 *   `collections/<slug>/`（`slug = sanitizeSegment(name) + 短id`），无 url。
 * `created_at` 为秒级整数。
 */
export interface Collection {
  id: string;
  kind: CollectionKind;
  name: string;
  created_at: number;
  share_id?: string;
  url?: string;
  pwd?: string | null;
  relDir?: string;
}

/** 本地文件条目：`relPath` 均相对 `target_dir`（posix 风格 `/` 分隔）；`absPath` 为本地绝对路径（供播放/拖拽用）。 */
export interface LocalItem {
  name: string;
  relPath: string;
  isDir: boolean;
  size: number;
  mtime: number;
  absPath: string;
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

/** collection_add 入参：按 kind 分参。 */
export type AddCollectionInput =
  | { kind: "alipan"; url: string; pwd?: string }
  | { kind: "xiaohongshu"; name: string };

/** 小红书解析结果（M3，仅视频期）。 */
export interface XhsParseResult {
  title: string;
  downloadUrl: string;
  cover: string;
  noteId: string;
  author: string;
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

// ---- Channel 名 ----

/** IPC channel 名联合类型。 */
export type IpcChannel =
  | "collection_list"
  | "collection_add"
  | "collection_rename"
  | "collection_remove"
  | "fs_list"
  | "fs_mkdir"
  | "fs_rename"
  | "fs_move"
  | "fs_remove"
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
  | "thumbnail_local"
  | "thumbnail_local_warm"
  | "clipboard_read_text"
  | "xhs_parse"
  | "xhs_import";

/** 各 channel 的 invoke 入参（顶层 camelCase）。 */
export interface IpcParams {
  collection_list: Record<string, never>;
  collection_add: AddCollectionInput;
  collection_rename: { id: string; name: string };
  collection_remove: { id: string };
  fs_list: { relDir?: string };
  fs_mkdir: { relDir: string };
  fs_rename: { relPath: string; name: string };
  fs_move: { relPath: string; destDir: string };
  fs_remove: { relPath: string };
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
  /** 本地视频缩略图预取：缺失项 ffmpeg 抽帧，返回命中的 relPath → 本地媒体 URL。 */
  thumbnail_local_warm: { files: string[] };
  /** 读系统剪贴板纯文本（新建合集/导入弹窗自动填入用，失败返回空串）。 */
  clipboard_read_text: Record<string, never>;
  /** 小红书解析：短链先跟随跳转，仅视频期。 */
  xhs_parse: { url: string };
  /** 小红书导入：先 parse 再落盘到合集目录，返回 "started"/"downloading"。 */
  xhs_import: { url: string; collectionId: string; subDir?: string; fileName?: string };
}

/** 各 channel 的 invoke 返回。 */
export interface IpcResult {
  collection_list: Collection[];
  collection_add: Collection;
  collection_rename: Collection;
  collection_remove: void;
  fs_list: LocalItem[];
  fs_mkdir: void;
  fs_rename: void;
  fs_move: void;
  fs_remove: void;
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
  thumbnail_local_warm: { cached: Record<string, string> };
  clipboard_read_text: string;
  xhs_parse: XhsParseResult;
  xhs_import: string;
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
