/**
 * CLI `import alipan` 链路：分享链接 → 定位文件 → 现取预览地址 → 落盘下载。
 *
 * 全部复用主进程既有模块，不复制逻辑：
 * - 链接解析 `parseShareUrl/extractShareId`（`electron/main/store.ts`）；
 * - 目录翻页 `list_share`（`electron/main/share-api.ts`，`LIST_PAGE_LIMIT=100`）；
 * - 已存短路 `getStatusBatch`（`electron/main/store.ts`）；
 * - 预览地址 `pick_preview_url` 现取现用（签名约 2h，绝不缓存）；
 * - 落盘 `downloadVideo`（`electron/main/downloader.ts`）＋ `waitForDone` 等对应 file_id。
 *
 * `--path` 按 `/` 逐段进目录定位（根 file_id 约定 `"root"`，与 UI 一致）；
 * `--all` 逐个串行下载，单失败记录继续。
 */

import { parseArgs } from "node:util";

import { downloadVideo } from "../../electron/main/downloader.js";
import {
  isTemplateUsable,
  LIST_MAX_PAGES,
  LIST_PAGE_LIMIT,
  list_share,
  pick_preview_url,
  ShareClient,
} from "../../electron/main/share-api.js";
import type {
  Definition,
  FileStatus,
  ListShareResult,
  PickPreviewResult,
  ShareItem,
  VideoPreview,
} from "../../electron/shared/contract.js";
import {
  extractShareId,
  getConfig,
  getStatusBatch,
  parseShareUrl,
} from "../../electron/main/store.js";
import { waitForDone } from "../lib/await-download.js";
import type { CliContext, CliResult } from "../lib/context.js";
import { resolveTargetDir } from "../lib/target.js";

/** 用法行（与 `importCommand` 的 alipan 分支保持一致）。 */
const USAGE =
  "import alipan <url|share_id> (--file-id <file_id> | --path <分享内路径> | --all [--path <目录>]) [--pwd <提取码>] [--url <url>] [--definition AUTO|HD|SD] [--subdir <子目录>] [--dry-run] [--timeout <秒>]";

/** `--timeout` 缺省值（秒）：与 `waitForDone` 默认 30 分钟对齐，单文件维度声明一次。 */
const DEFAULT_TIMEOUT_SECS = 1800;

/** 视频扩展名集合：与 `FolderView.isVideoFile` 同规则，此处内联以免 CLI 依赖 renderer 模块。 */
const VIDEO_EXTS: readonly string[] = ["mp4", "mkv", "mov", "m3u8", "avi", "webm"];

/** 解析后的命令参数（`parseArgs` 收敛后的强类型形状）。 */
interface AlipanArgs {
  input: string | undefined;
  pwd: string | undefined;
  fileId: string | undefined;
  pathProvided: boolean;
  pathRaw: string;
  all: boolean;
  definitionRaw: string | undefined;
  subdir: string | undefined;
  dryRun: boolean;
  timeoutSecs: number;
  help: boolean;
}

/** 文件定位器：`--file-id` 直指根下文件，`--path` 逐段定位，`--all` 批量定位目录。 */
type Locator =
  | { kind: "file-id"; fileId: string }
  | { kind: "path"; segs: string[] }
  | { kind: "all"; segs: string[] };

/** 已定位的单文件（含落盘子目录与取预览所需的 drive 标识）。 */
interface LocatedFile {
  driveId: string;
  fileId: string;
  name: string;
  subDir: string;
}

/** 已定位的批量目录（`relPath` 为相对分享根的 `/` 拼接，根即空串）。 */
interface LocatedDir {
  dirId: string;
  relPath: string;
}

/** 单文件下载结果（含已存短路的跳过标记）。 */
interface DownloadOutcome {
  fileId: string;
  name: string;
  path: string;
  template: string;
  skipped: boolean;
}

/** 批量失败明细。 */
interface BatchFailure {
  file_id: string;
  name: string;
  error: string;
}

/** 旗标组合错误（定位到目录/文件类型与 `--all` 不匹配时抛，调用方映射为用法错误）。 */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** 参数缺失或非法时的用法错误结果（code 1）。 */
function usageError(reason: string): CliResult {
  const human: string = `${reason}\n用法：${USAGE}`;
  return { code: 1, human, error: reason, errorCode: "USAGE" };
}

/** 业务失败结果（code 2）：错误文案透传底层抛出的 message。 */
function opError(message: string, errorCode: string): CliResult {
  return { code: 2, human: message, error: message, errorCode };
}

/** 取 Error 的 message，其余值转字符串。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 空串视为未提供（`--pwd ""` 等价于缺省，避免空串污染后续判空）。 */
function cleanFlag(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t: string = v.trim();
  return t === "" ? undefined : t;
}

/**
 * 解析 `import alipan` 之后的参数。
 *
 * @param argv - `import alipan` 之后的参数
 * @returns 收敛后的强类型参数
 */
function parseAlipanArgs(argv: string[]): AlipanArgs {
  const parsed = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      pwd: { type: "string" },
      "file-id": { type: "string" },
      path: { type: "string" },
      all: { type: "boolean", default: false },
      definition: { type: "string" },
      subdir: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const positionals: string[] = parsed.positionals;
  if (positionals.length > 1) {
    const extra: string | undefined = positionals[1];
    throw new Error(`未知参数：${extra ?? ""}`);
  }
  const positionalRaw: string | undefined = positionals[0];
  const positional: string | undefined = cleanFlag(positionalRaw);
  const url: string | undefined = cleanFlag(parsed.values.url);
  if (positional !== undefined && url !== undefined) {
    throw new Error("--url 与位置参数 <url|share_id> 互斥，只能给一个");
  }
  const fileIdRaw: string | undefined = parsed.values["file-id"];
  if (fileIdRaw !== undefined && fileIdRaw.trim() === "") {
    throw new Error("--file-id 不能为空");
  }
  let timeoutSecs: number = DEFAULT_TIMEOUT_SECS;
  const timeoutRaw: string | undefined = parsed.values.timeout;
  if (timeoutRaw !== undefined) {
    const n: number = Number(timeoutRaw.trim());
    if (timeoutRaw.trim() === "" || !Number.isFinite(n) || n <= 0) {
      throw new Error(`--timeout 须为正数秒数（当前：${timeoutRaw}）`);
    }
    timeoutSecs = n;
  }
  return {
    input: positional ?? url,
    pwd: cleanFlag(parsed.values.pwd),
    fileId: cleanFlag(fileIdRaw),
    pathProvided: parsed.values.path !== undefined,
    pathRaw: parsed.values.path ?? "",
    all: parsed.values.all ?? false,
    definitionRaw: cleanFlag(parsed.values.definition),
    subdir: cleanFlag(parsed.values.subdir),
    dryRun: parsed.values["dry-run"] ?? false,
    timeoutSecs,
    help: parsed.values.help ?? false,
  };
}

/**
 * 解析分享输入为 share_id（URL 走 `parseShareUrl/extractShareId`，其余视为裸 id）。
 *
 * @param raw - 位置参数或 `--url` 的值
 * @returns share_id
 */
function resolveShareId(raw: string): string {
  const v: string = raw.trim();
  const lower: string = v.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://")) {
    return extractShareId(parseShareUrl(v));
  }
  if (v === "" || /\s/.test(v) || v.includes("/")) {
    throw new Error(`非法的 share_id（裸 id 不含空白与斜杠，链接须以 http(s):// 开头）：${raw}`);
  }
  return v;
}

/**
 * 校验显式档位（大小写不敏感）。内联校验以便非法值映射为用法错误而非业务失败。
 *
 * @param raw - `--definition` 的值
 * @returns 档位
 */
function normalizeDefinitionFlag(raw: string): Definition {
  const v: string = raw.trim().toUpperCase();
  if (v === "AUTO" || v === "HD" || v === "SD") return v;
  throw new Error(`definition 仅支持 AUTO|HD|SD（当前：${raw.trim()}）`);
}

/**
 * 构建文件定位器（`--file-id` 不与 `--path`/`--all` 同用；`--all` 可带 `--path` 选目录）。
 *
 * @param args - 解析后的参数
 * @returns 定位器
 */
function buildLocator(args: AlipanArgs): Locator {
  const hasFileId: boolean = args.fileId !== undefined;
  if (hasFileId && (args.pathProvided || args.all)) {
    throw new Error("--file-id 不能与 --path / --all 同用");
  }
  if (!hasFileId && !args.pathProvided && !args.all) {
    throw new Error("缺少文件定位参数：--file-id / --path / --all 三选一");
  }
  if (hasFileId) {
    const fileId: string | undefined = args.fileId;
    if (fileId === undefined) throw new Error("缺少文件定位参数：--file-id / --path / --all 三选一");
    return { kind: "file-id", fileId };
  }
  if (args.all) {
    return { kind: "all", segs: splitSharePath(args.pathRaw) };
  }
  return { kind: "path", segs: splitSharePath(args.pathRaw) };
}

/**
 * 分享内路径按 `/` 切段（首尾斜杠忽略，空即分享根）。
 *
 * @param raw - `--path` 的值
 * @returns 路径段
 */
function splitSharePath(raw: string): string[] {
  const segs: string[] = raw
    .split("/")
    .map((s: string): string => s.trim())
    .filter((s: string): boolean => s !== "");
  for (const s of segs) {
    if (s === "." || s === "..") throw new Error(`分享内路径不支持 ${s}：${raw}`);
  }
  return segs;
}

/**
 * 与 `FolderView.isVideoFile` 同规则的视频判定（内联，见 `VIDEO_EXTS` 注释）。
 *
 * @param item - 分享目录条目
 * @returns 是否为视频文件
 */
function isVideoItem(item: ShareItem): boolean {
  if (item.type === "folder") return false;
  if (item.category === "video") return true;
  const ext: string = (item.file_extension ?? "").toLowerCase();
  return VIDEO_EXTS.includes(ext);
}

/**
 * 列出某目录下全部分页（`LIST_PAGE_LIMIT=100` 单页，`LIST_MAX_PAGES` 封顶防异常循环）。
 *
 * @param shareId - 分享 id
 * @param parentFileId - 父目录 id（根为 `"root"`）
 * @param pwd - 提取码
 * @returns 该目录下全部条目
 */
async function listDirAll(
  shareId: string,
  parentFileId: string,
  pwd: string | undefined,
): Promise<ShareItem[]> {
  const out: ShareItem[] = [];
  let marker: string | undefined = undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const res: ListShareResult = await list_share(shareId, parentFileId, marker, LIST_PAGE_LIMIT, pwd);
    out.push(...res.items);
    if (res.next_marker === "") break;
    marker = res.next_marker;
  }
  return out;
}

/**
 * `--file-id` 定位：根目录扫描同 id 的文件（深层文件请用 `--path`，避免全盘递归触发限流）。
 *
 * @param shareId - 分享 id
 * @param fileId - 文件 id
 * @param pwd - 提取码
 * @returns 已定位的单文件
 */
async function locateFileById(
  shareId: string,
  fileId: string,
  pwd: string | undefined,
): Promise<LocatedFile> {
  const items: ShareItem[] = await listDirAll(shareId, "root", pwd);
  const hit: ShareItem | undefined = items.find(
    (it: ShareItem): boolean => it.file_id === fileId && it.type !== "folder",
  );
  if (hit === undefined) {
    throw new Error(`分享根目录无此 file_id：${fileId}（深层文件请用 --path 定位）`);
  }
  if (!isVideoItem(hit)) throw new Error(`非视频文件：${hit.name}`);
  return { driveId: hit.drive_id, fileId: hit.file_id, name: hit.name, subDir: "" };
}

/**
 * `--path` 定位单文件：除末段外逐段进目录，末段按名匹配文件。
 *
 * @param shareId - 分享 id
 * @param segs - 路径段（非空）
 * @param pwd - 提取码
 * @returns 已定位的单文件（`subDir` 为所在目录相对分享根的拼接，与 UI stack 语义一致）
 */
async function locateFileByPath(
  shareId: string,
  segs: string[],
  pwd: string | undefined,
): Promise<LocatedFile> {
  let parentId: string = "root";
  for (let i = 0; i < segs.length - 1; i++) {
    const seg: string = segs[i] as string;
    const items: ShareItem[] = await listDirAll(shareId, parentId, pwd);
    const hit: ShareItem | undefined = items.find(
      (it: ShareItem): boolean => it.type === "folder" && it.name === seg,
    );
    if (hit === undefined) throw new Error(`分享内无此目录：/${segs.slice(0, i + 1).join("/")}`);
    parentId = hit.file_id;
  }
  const leaf: string = segs[segs.length - 1] as string;
  const siblings: ShareItem[] = await listDirAll(shareId, parentId, pwd);
  const hit: ShareItem | undefined = siblings.find((it: ShareItem): boolean => it.name === leaf);
  if (hit === undefined) throw new Error(`分享内无此文件：/${segs.join("/")}`);
  if (hit.type === "folder") {
    throw new UsageError(`--path 指向目录：批量下载请加 --all（/${segs.join("/")}）`);
  }
  if (!isVideoItem(hit)) throw new Error(`非视频文件：${hit.name}`);
  return {
    driveId: hit.drive_id,
    fileId: hit.file_id,
    name: hit.name,
    subDir: segs.slice(0, -1).join("/"),
  };
}

/**
 * `--all` 定位目录：空即分享根，否则逐段进目录（末段须为目录）。
 *
 * @param shareId - 分享 id
 * @param segs - 路径段（空即根）
 * @param pwd - 提取码
 * @returns 已定位的目录
 */
async function locateDirByPath(
  shareId: string,
  segs: string[],
  pwd: string | undefined,
): Promise<LocatedDir> {
  let dirId: string = "root";
  for (let i = 0; i < segs.length; i++) {
    const seg: string = segs[i] as string;
    const items: ShareItem[] = await listDirAll(shareId, dirId, pwd);
    const hit: ShareItem | undefined = items.find(
      (it: ShareItem): boolean => it.type === "folder" && it.name === seg,
    );
    if (hit === undefined) throw new Error(`分享内无此目录：/${segs.slice(0, i + 1).join("/")}`);
    dirId = hit.file_id;
  }
  return { dirId, relPath: segs.join("/") };
}

/**
 * 下载单个文件：已 saved 短路 → 预览地址现取现用 → `waitForDone` 等对应 file_id。
 *
 * @param ctx - CLI 上下文
 * @param shareId - 分享 id
 * @param pwd - 提取码
 * @param file - 已定位的单文件
 * @param subDir - 落盘子目录
 * @param definition - 清晰度档位
 * @param timeoutMs - 单文件超时（毫秒）
 * @returns 下载结果
 */
async function downloadOne(
  ctx: CliContext,
  shareId: string,
  pwd: string | undefined,
  file: { driveId: string; fileId: string; name: string },
  subDir: string,
  definition: Definition,
  timeoutMs: number,
): Promise<DownloadOutcome> {
  const statuses: FileStatus[] = await getStatusBatch(ctx.userDataDir, shareId, [file.fileId]);
  const saved: FileStatus | undefined = statuses.find(
    (s: FileStatus): boolean => s.file_id === file.fileId && s.state === "saved",
  );
  if (saved !== undefined) {
    return { fileId: file.fileId, name: file.name, path: saved.path ?? "", template: "", skipped: true };
  }
  const picked: PickPreviewResult = await pick_preview_url(
    shareId,
    file.driveId,
    file.fileId,
    definition,
    pwd,
  );
  const targetPath: string = await waitForDone(
    (emit) =>
      downloadVideo({
        m3u8Url: picked.url,
        shareId,
        fileId: file.fileId,
        fileName: file.name,
        template: picked.template,
        subDir,
        userDataDir: ctx.userDataDir,
        emit,
      }),
    file.fileId,
    { timeoutMs },
  );
  return { fileId: file.fileId, name: file.name, path: targetPath, template: picked.template, skipped: false };
}

/**
 * `--dry-run` 单文件：只列可用档位，不下载。
 *
 * @param shareId - 分享 id
 * @param pwd - 提取码
 * @param file - 已定位的单文件
 * @param definition - 偏好档位（仅用于无可用档时的提示）
 * @returns 可用档位列表结果
 */
async function runDryRunSingle(
  shareId: string,
  pwd: string | undefined,
  file: LocatedFile,
  definition: Definition,
): Promise<CliResult> {
  let templates: VideoPreview[];
  try {
    templates = await new ShareClient(shareId, pwd).videoPreview(file.driveId, file.fileId);
  } catch (e) {
    return opError(errMsg(e), "DRY_RUN_FAILED");
  }
  const usable: VideoPreview[] = templates.filter(isTemplateUsable);
  if (usable.length === 0) {
    return opError(`没有可用的预览档（偏好 ${definition}）：${file.name}`, "DRY_RUN_FAILED");
  }
  const rows: string[] = usable.map((t: VideoPreview): string => {
    const size: string =
      t.template_width !== undefined && t.template_height !== undefined
        ? ` ${t.template_width}x${t.template_height}`
        : "";
    return `${t.template_id}${size}`;
  });
  // 签名 preview_url 不进 data：2h 有效的带签 URL 不应落日志。
  const publicTemplates = usable.map(
    (t: VideoPreview): Pick<VideoPreview, "template_id" | "template_name" | "template_width" | "template_height" | "status"> => ({
      template_id: t.template_id,
      template_name: t.template_name,
      template_width: t.template_width,
      template_height: t.template_height,
      status: t.status,
    }),
  );
  return {
    code: 0,
    human: `可用档位（${file.name}）：\n${rows.join("\n")}`,
    data: { shareId, fileId: file.fileId, definition, templates: publicTemplates },
  };
}

/**
 * `--all` 批量：定位目录 → 收集全部视频 → 逐个串行下载（`--dry-run` 只列文件，不逐项取预览以免限流）。
 *
 * @param ctx - CLI 上下文
 * @param shareId - 分享 id
 * @param pwd - 提取码
 * @param segs - 目录路径段（空即根）
 * @param args - 解析后的参数
 * @param definition - 清晰度档位
 * @param timeoutMs - 单文件超时（毫秒）
 * @returns 汇总结果（部分失败 code 仍 0，全部失败 code 2）
 */
async function runBatch(
  ctx: CliContext,
  shareId: string,
  pwd: string | undefined,
  segs: string[],
  args: AlipanArgs,
  definition: Definition,
  timeoutMs: number,
): Promise<CliResult> {
  let dir: LocatedDir;
  try {
    dir = await locateDirByPath(shareId, segs, pwd);
  } catch (e) {
    if (e instanceof UsageError) return usageError(errMsg(e));
    return opError(errMsg(e), "LOCATE_FAILED");
  }
  let items: ShareItem[];
  try {
    items = await listDirAll(shareId, dir.dirId, pwd);
  } catch (e) {
    return opError(errMsg(e), "LOCATE_FAILED");
  }
  const videos: ShareItem[] = items.filter(isVideoItem);
  if (videos.length === 0) return opError("目录下无视频文件", "NO_VIDEO");
  const subDir: string = args.subdir !== undefined ? args.subdir : dir.relPath;
  if (args.dryRun) {
    const rows: string[] = videos.map((v: ShareItem): string => `${v.name} ${v.file_id}`);
    return {
      code: 0,
      human: `将下载 ${videos.length} 个视频：\n${rows.join("\n")}`,
      data: {
        shareId,
        dir: dir.relPath,
        files: videos.map((v: ShareItem) => ({ file_id: v.file_id, name: v.name })),
      },
    };
  }
  const succeeded: DownloadOutcome[] = [];
  const failed: BatchFailure[] = [];
  for (const v of videos) {
    try {
      succeeded.push(
        await downloadOne(
          ctx,
          shareId,
          pwd,
          { driveId: v.drive_id, fileId: v.file_id, name: v.name },
          subDir,
          definition,
          timeoutMs,
        ),
      );
    } catch (e) {
      failed.push({ file_id: v.file_id, name: v.name, error: errMsg(e) });
    }
  }
  const lines: string[] = [`成功 ${succeeded.length} / 失败 ${failed.length}`];
  for (const f of failed) lines.push(`失败：${f.name}（${f.error}）`);
  const human: string = lines.join("\n");
  const data = { shareId, dir: dir.relPath, definition, subDir, succeeded, failed };
  if (failed.length === videos.length) {
    return { code: 2, human, data, error: `全部失败：${videos.length} 个文件均下载失败`, errorCode: "BATCH_FAILED" };
  }
  return { code: 0, human, data };
}

/**
 * `import alipan` 入口：argv 为 `import alipan` 之后的参数。
 *
 * @param ctx - CLI 上下文
 * @param argv - `import alipan` 之后的参数
 * @returns 执行结果（0 成功、1 用法错误、2 业务失败）
 */
export async function runAlipan(ctx: CliContext, argv: string[]): Promise<CliResult> {
  let args: AlipanArgs;
  try {
    args = parseAlipanArgs(argv);
  } catch (e) {
    return usageError(errMsg(e));
  }
  if (args.help) return { code: 0, human: `用法：${USAGE}` };
  if (args.input === undefined) {
    return usageError("缺少参数：<url|share_id>（位置参数或 --url）");
  }
  let shareId: string;
  try {
    shareId = resolveShareId(args.input);
  } catch (e) {
    return usageError(errMsg(e));
  }
  let definition: Definition;
  if (args.definitionRaw !== undefined) {
    try {
      definition = normalizeDefinitionFlag(args.definitionRaw);
    } catch (e) {
      return usageError(errMsg(e));
    }
  } else {
    try {
      definition = (await getConfig(ctx.userDataDir)).definition;
    } catch (e) {
      return opError(errMsg(e), "CONFIG_FAILED");
    }
  }
  let locator: Locator;
  try {
    locator = buildLocator(args);
  } catch (e) {
    return usageError(errMsg(e));
  }
  if (locator.kind === "path" && locator.segs.length === 0) {
    return usageError("--path 指向分享根目录：单文件请指向具体文件，批量请加 --all");
  }
  let targetDir: string | undefined;
  // dry-run 不落盘：跳过目标目录预检，无配置也能看档位。
  async function needTargetDir(): Promise<string> {
    try {
      return await resolveTargetDir(ctx.userDataDir, ctx.targetDirOverride);
    } catch (e) {
      throw new Error(errMsg(e));
    }
  }
  const timeoutMs: number = Math.floor(args.timeoutSecs * 1000);
  const pwd: string | undefined = args.pwd;
  if (locator.kind === "all") {
    if (!args.dryRun) {
      try {
        await needTargetDir();
      } catch (e) {
        return opError(errMsg(e), "TARGET_MISSING");
      }
    }
    return runBatch(ctx, shareId, pwd, locator.segs, args, definition, timeoutMs);
  }
  let located: LocatedFile;
  try {
    located =
      locator.kind === "file-id"
        ? await locateFileById(shareId, locator.fileId, pwd)
        : await locateFileByPath(shareId, locator.segs, pwd);
  } catch (e) {
    if (e instanceof UsageError) return usageError(errMsg(e));
    return opError(errMsg(e), "LOCATE_FAILED");
  }
  const subDir: string = args.subdir !== undefined ? args.subdir : located.subDir;
  if (args.dryRun) {
    return runDryRunSingle(shareId, pwd, located, definition);
  }
  try {
    targetDir = await needTargetDir();
  } catch (e) {
    return opError(errMsg(e), "TARGET_MISSING");
  }
  let outcome: DownloadOutcome;
  try {
    outcome = await downloadOne(ctx, shareId, pwd, located, subDir, definition, timeoutMs);
  } catch (e) {
    return opError(errMsg(e), "DOWNLOAD_FAILED");
  }
  const data = {
    shareId,
    targetDir,
    fileId: outcome.fileId,
    driveId: located.driveId,
    fileName: outcome.name,
    path: outcome.path,
    template: outcome.template,
    subDir,
    definition,
    skipped: outcome.skipped,
  };
  if (outcome.skipped) {
    return { code: 0, human: `已保存 ${outcome.name}：${outcome.path}`, data };
  }
  return { code: 0, human: `已下载 ${outcome.name} → ${outcome.path}（${outcome.template}）`, data };
}
