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
  ShareItem,
  ShareItemType,
  ShareMeta,
  StatusQueryResult,
  UnlistenFn,
  VideoPreview,
} from "../../electron/shared/contract";
import { withRateLimitRetry } from "./rateLimit";

// ---- 合集模型（M4：SavedShare → Collection 改名） ----

/** 合集类型：阿里云盘分享 / 小红书本地合集。 */
export type CollectionKind = "alipan" | "xiaohongshu";

/** 合集：新后端 collection_* 形状；兼容旧后端 list_shares 形状（share_id）。 */
export interface Collection {
  collection_id: string;
  kind: CollectionKind;
  name: string;
  url?: string | null;
  pwd?: string | null;
  added_at: number;
  /** 小红书合集根目录（相对 target_dir，如 collections/foo-abc123）；alipan 为空。 */
  relDir?: string;
  /** 合集分类（可选，空/缺省即未分类）。 */
  category?: string | null;
}

/** 后端原始合集（新形状或旧 SavedShare 形状），映射前用。 */
type RawCollection = Record<string, unknown>;

/** 后端原始条目 → Collection（新旧兼容：新后端用 id/created_at）。 */
function toCollection(raw: RawCollection): Collection {
  const collection_id =
    typeof raw["collection_id"] === "string"
      ? (raw["collection_id"] as string)
      : typeof raw["id"] === "string"
        ? (raw["id"] as string)
        : typeof raw["share_id"] === "string"
          ? (raw["share_id"] as string)
          : "";
  const kindRaw = raw["kind"];
  const kind: CollectionKind = kindRaw === "xiaohongshu" ? "xiaohongshu" : "alipan";
  const name = typeof raw["name"] === "string" ? (raw["name"] as string) : "";
  const url = typeof raw["url"] === "string" ? (raw["url"] as string) : null;
  const pwd =
    typeof raw["pwd"] === "string" ? (raw["pwd"] as string) : null;
  const added_at =
    typeof raw["added_at"] === "number"
      ? (raw["added_at"] as number)
      : typeof raw["created_at"] === "number"
        ? (raw["created_at"] as number)
        : 0;
  const relDir =
    typeof raw["relDir"] === "string"
      ? (raw["relDir"] as string)
      : typeof raw["rel_dir"] === "string"
        ? (raw["rel_dir"] as string)
        : undefined;
  const categoryRaw =
    typeof raw["category"] === "string" ? (raw["category"] as string).trim() : "";
  const category = categoryRaw === "" ? undefined : categoryRaw;
  return { collection_id, kind, name, url, pwd, added_at, relDir, category };
}

// ---- 本地文件 / 小红书模型 ----

/** 本地文件条目（fs_list 返回，relPath 相对 target_dir）。 */
export interface FsEntry {
  relPath: string;
  name: string;
  isDir: boolean;
  size?: number;
  absPath?: string;
  mtime?: number;
}

/** xhs 链接解析回显。 */
export interface XhsParseResult {
  title: string;
  cover?: string;
  author?: string;
  url: string;
}

/** xhs 导入返回（落盘相对路径等，后端字段原样透传）。 */
export interface XhsImportResult {
  relPath?: string;
  count?: number;
}

// ---- 传输层：经 preload 桥 window.fastcut 调用 main ----

function invoke<C extends IpcChannel>(channel: C, args?: IpcParams[C]): Promise<IpcResult[C]> {
  const bridge = window.fastcut;
  if (bridge === undefined || typeof bridge.invoke !== "function") {
    throw new Error(`fastcut bridge unavailable, cannot invoke "${channel}"`);
  }
  return bridge.invoke(channel, args);
}

/** 无类型约束的原始调用（新 channel 后端尚未注册时抛错，由兼容层捕获回退）。 */
function invokeRaw<T>(channel: string, args?: unknown): Promise<T> {
  const bridge = window.fastcut;
  if (bridge === undefined || typeof bridge.invoke !== "function") {
    throw new Error(`fastcut bridge unavailable, cannot invoke "${channel}"`);
  }
  const fn = bridge.invoke as (c: string, a?: unknown) => Promise<T>;
  return fn(channel, args);
}

/** 是否为“新 channel 未注册”类错误（此时才允许回退旧 channel）。 */
function isMissingHandlerError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("No handler") ||
    msg.includes("no handler") ||
    msg.includes("unknown channel") ||
    msg.includes("UNKNOWN") ||
    msg.includes("not registered") ||
    msg.includes("not found")
  );
}

/**
 * 接口 mismatch 兜底：优先调新 channel，失败（未注册类错误）回退旧 channel。
 *
 * @param newChannel - 新 channel 名
 * @param newArgs - 新入参
 * @param oldChannel - 旧 channel 名（无旧等价时省略，错误直接上抛）
 * @param oldArgs - 旧入参
 * @returns 后端返回
 */
async function invokeCompat<T>(
  newChannel: string,
  newArgs: unknown,
  oldChannel?: IpcChannel,
  oldArgs?: unknown,
): Promise<T> {
  try {
    return await invokeRaw<T>(newChannel, newArgs);
  } catch (e) {
    if (oldChannel !== undefined && isMissingHandlerError(e)) {
      return (await invoke(oldChannel, oldArgs as never)) as unknown as T;
    }
    throw e;
  }
}

function listen<K extends "download-progress" | "download-done">(
  event: K,
  handler: (
    payload: K extends "download-progress" ? DownloadProgressPayload : DownloadDonePayload,
  ) => void,
): Promise<UnlistenFn> {
  const bridge = window.fastcut;
  if (bridge === undefined) {
    throw new Error(`fastcut bridge unavailable, cannot listen "${event}"`);
  }
  if (event === "download-progress") {
    const off = bridge.onDownloadProgress(handler as (payload: DownloadProgressPayload) => void);
    return Promise.resolve(off);
  }
  const off = bridge.onDownloadDone(handler as (payload: DownloadDonePayload) => void);
  return Promise.resolve(off);
}

// ---- 合集命令（新名优先，旧名回退） ----

export async function listCollections(): Promise<Collection[]> {
  const raw = await invokeRaw<RawCollection[] | { items?: RawCollection[] }>("collection_list", {});
  const arr = Array.isArray(raw) ? raw : (raw.items ?? []);
  return arr.map(toCollection);
}

/** 新建云盘合集（链接+密码，分类可选）。 */
export function addCollection(
  kind: "alipan",
  args: { url: string; pwd?: string; category?: string },
): Promise<Collection>;
/** 新建小红书合集（合集名，分类可选）。 */
export function addCollection(
  kind: "xiaohongshu",
  args: { name: string; category?: string },
): Promise<Collection>;
export async function addCollection(
  kind: CollectionKind,
  args: { url?: string; pwd?: string; name?: string; category?: string },
): Promise<Collection> {
  const category = args.category?.trim() === "" ? undefined : args.category?.trim();
  if (kind === "alipan") {
    const url = args.url ?? "";
    const pwd = args.pwd;
    const raw = await invokeRaw<RawCollection>("collection_add", { kind, url, pwd, category });
    return toCollection(raw);
  }
  const name = (args.name ?? "").trim();
  if (name === "") throw new Error("请输入合集名");
  const raw = await invokeRaw<RawCollection>("collection_add", { kind, name, category });
  return toCollection(raw);
}

export async function renameCollection(collection_id: string, name: string): Promise<Collection> {
  const raw = await invokeRaw<RawCollection>("collection_rename", {
    id: collection_id,
    collectionId: collection_id,
    collection_id,
    name,
  });
  return toCollection(raw);
}

export async function removeCollection(collection_id: string): Promise<void> {
  await invokeRaw<void>("collection_remove", {
    id: collection_id,
    collectionId: collection_id,
    collection_id,
  });
}

/** 设置合集分类：空串即移出分类（未分类）。 */
export async function setCollectionCategory(
  collection_id: string,
  category?: string,
): Promise<Collection> {
  const raw = await invokeRaw<RawCollection>("collection_set_category", {
    id: collection_id,
    collectionId: collection_id,
    collection_id,
    category,
  });
  return toCollection(raw);
}

// ---- 阿里云盘只读命令（沿用旧 channel，参数名不变） ----

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
  // 瞬时限流退避一次（主进程内还有一次 1s 重试）：首屏与翻页统一兜底。
  return withRateLimitRetry(() =>
    invoke("list_share", {
      shareId: share_id,
      parentFileId: parent_file_id,
      marker,
      limit,
      pwd,
    }),
  );
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

// ---- 本地文件命令（fs_*，relDir/relPath 相对 target_dir） ----

function toFsEntries(raw: unknown): FsEntry[] {
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? ((raw as Record<string, unknown>)["entries"] as unknown[] ??
        (raw as Record<string, unknown>)["items"] as unknown[] ??
        [])
      : [];
  const out: FsEntry[] = [];
  for (const e of arr) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    const relPath =
      typeof r["relPath"] === "string"
        ? (r["relPath"] as string)
        : typeof r["rel_path"] === "string"
          ? (r["rel_path"] as string)
          : typeof r["file_id"] === "string"
            ? (r["file_id"] as string)
            : "";
    const name =
      typeof r["name"] === "string" ? (r["name"] as string) : relPath.split("/").pop() ?? relPath;
    const isDir =
      typeof r["isDir"] === "boolean"
        ? (r["isDir"] as boolean)
        : typeof r["is_dir"] === "boolean"
          ? (r["is_dir"] as boolean)
          : r["type"] === "folder";
    const size = typeof r["size"] === "number" ? (r["size"] as number) : undefined;
    const absPath = typeof r["absPath"] === "string" ? (r["absPath"] as string) : undefined;
    const mtime = typeof r["mtime"] === "number" ? (r["mtime"] as number) : undefined;
    out.push({ relPath, name, isDir, size, absPath, mtime });
  }
  return out;
}

export async function fsList(relDir = ""): Promise<FsEntry[]> {
  const raw = await invokeCompat<unknown>("fs_list", { relDir, rel_dir: relDir });
  return toFsEntries(raw);
}

export async function fsMkdir(relDir: string, name: string): Promise<void> {
  const clean = name.trim();
  // 后端 fs_mkdir 入参为完整新目录路径（相对 target_dir），此处拼接父目录+单段名。
  const full = relDir.trim() === "" ? clean : `${relDir.replace(/\/+$/, "")}/${clean}`;
  await invokeCompat<void>("fs_mkdir", { relDir: full, rel_dir: full, name: clean });
}

export async function fsRename(relPath: string, newName: string): Promise<void> {
  await invokeCompat<void>("fs_rename", {
    relPath,
    rel_path: relPath,
    newName,
    name: newName,
  });
}

export async function fsMove(srcRelPath: string, destDir: string): Promise<void> {
  await invokeCompat<void>("fs_move", {
    srcRelPath,
    src_rel_path: srcRelPath,
    relPath: srcRelPath,
    destDir,
    dest_dir: destDir,
  });
}

export async function fsRemove(relPath: string): Promise<void> {
  await invokeCompat<void>("fs_remove", { relPath, rel_path: relPath });
}

// ---- 小红书命令（xhs_*） ----

export async function xhsParse(url: string): Promise<XhsParseResult> {
  const raw = await invokeRaw<Record<string, unknown>>("xhs_parse", { url });
  return {
    title: typeof raw["title"] === "string" ? (raw["title"] as string) : "",
    cover: typeof raw["cover"] === "string" ? (raw["cover"] as string) : undefined,
    author: typeof raw["author"] === "string" ? (raw["author"] as string) : undefined,
    url,
  };
}

export async function xhsImport(
  url: string,
  opts?: { collectionId?: string; relDir?: string },
): Promise<XhsImportResult> {
  // 契约入参为 {url, collectionId, subDir?, fileName?}，返回 "started"/"downloading" 字符串。
  const subDir = opts?.relDir ?? "";
  const raw = await invokeRaw<unknown>("xhs_import", {
    url,
    collectionId: opts?.collectionId,
    collection_id: opts?.collectionId,
    subDir,
    sub_dir: subDir,
    relDir: subDir,
    rel_dir: subDir,
  });
  if (typeof raw === "string") return {};
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  return {
    relPath:
      typeof r["relPath"] === "string"
        ? (r["relPath"] as string)
        : typeof r["rel_path"] === "string"
          ? (r["rel_path"] as string)
          : undefined,
    count: typeof r["count"] === "number" ? (r["count"] as number) : undefined,
  };
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

/**
 * 本地视频缩略图预取：把一批 relPath 交给 main，缺失才 ffmpeg 抽帧；
 * 返回命中的 relPath → 本地媒体 URL（失败项直接缺席，调用方回退图标）。
 */
export function warmLocalVideoThumbnails(files: string[]): Promise<Record<string, string>> {
  return invoke("thumbnail_local_warm", { files }).then((r) => r.cached);
}

/**
 * 读系统剪贴板纯文本（main 侧 clipboard，无 renderer 权限问题）。
 * best-effort：桥不可用/失败一律返回空串，调用方按无链接处理。
 */
export async function readClipboardText(): Promise<string> {
  try {
    const text = await invoke("clipboard_read_text", {});
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
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
