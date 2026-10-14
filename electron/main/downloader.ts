/**
 * 视频下载后端：`src-tauri/src/downloader.rs` 的 TypeScript（Node）直译。
 *
 * 行为对照（逐项保留）：
 * - 分片并发 4（p-limit）、每请求重试 3 次（500ms*(attempt-1) 退避，30s 超时）。
 * - fetch_bytes 错误分类：超时→"请求超时"、网络错→"网络错误"、4xx→expired
 *   （"请求被拒（HTTP …)"）、5xx→"服务端异常"；m3u8 失败 expired 时拼
 *   "EXPIRED：签名可能已过期，请重取链接后重试"，分片失败带"（{done}/{total}）"后缀。
 * - parse_segments：含 EXT-X-KEY 直接 Err；跳过空行/#行；相对分片继承 m3u8 的
 *   signature query（resolve_segment 三分支）。空分片列表报"m3u8 中未找到分片"，
 *   空 blob 报"分片内容为空，下载中止"。
 * - resolve_target_dir：空串即 base；禁绝对路径（含 `C:` 盘符）、禁 `..`；
 *   逐段 sanitize_segment 清洗。
 * - unique_mp4_path：stem 为空→`video`，已存在→` (n)` 后缀。
 * - remux：`ffmpeg -hide_banner -loglevel error -i pipe:0 -c copy <out>`，
 *   stdin pipe 喂 blob；stderr 截 800 字。
 * - download_video 异步 fire-and-forget：空 m3u8 报"m3u8 链接为空"；同一
 *   `share_id:file_id` 重入返回 "downloading"；正常返回 "started"；完成发 done 事件。
 * - 进度事件每完成一片发一次 `{file_id, done, total}`。
 * - download_image 图片直链版：单文件流式 GET（content-length 进度，无需 ffmpeg），
 *   落盘保留原后缀，记账 template 为 "original"，与视频共用 inFlight 与事件名。
 * - ffmpeg 路径策略：优先 `ffmpeg-static` 自带二进制，其次系统 PATH 的 `ffmpeg`，
 *   都找不到才报"未检测到 ffmpeg，请先安装 ffmpeg 后再下载"。自检逻辑保留。
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import pLimit from "p-limit";
import ffmpegStatic from "ffmpeg-static";
import type {
  DownloadDonePayload,
  DownloadProgressPayload,
} from "../shared/contract.js";
import { sanitizeTitle } from "./xhs-client.js";
import { sanitizeSegment } from "./share-api.js";
import { getConfig, ledgerKey, recordLedger } from "./store.js";

// ---------------------------------------------------------------------------
// 跨模块依赖（Wave 3 已归一化为静态 import）
// ---------------------------------------------------------------------------
//
// - `sanitizeSegment` 来自 `./share-api.js`，`ledgerKey` / `recordLedger` /
//   `getConfig` 来自 `./store.js`。
// - 无循环依赖：store 永不 import downloader（`isDownloading` 经模块级
//   provider 注入，main 启动时调 `setIsDownloadingProvider` 接线）；
//   downloader → store 为单向依赖。

// ---------------------------------------------------------------------------
// 常量 / 状态
// ---------------------------------------------------------------------------

const SEG_CONCURRENCY = 4;
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 30_000;
const FFMPEG_MISSING_MSG = "未检测到 ffmpeg，请先安装 ffmpeg 后再下载";

/** 进行中的下载：`share_id:file_id` 集合（对应 Rust 的 IN_FLIGHT）。 */
const inFlight = new Set<string>();

export function isDownloading(shareId: string, fileId: string): boolean {
  return inFlight.has(ledgerKey(shareId, fileId));
}

// ---------------------------------------------------------------------------
// URL / m3u8 纯函数（全部 export，供单测与 Wave 3 复用）
// ---------------------------------------------------------------------------

function splitQuery(url: string): [base: string, query: string] {
  const i = url.indexOf("?");
  return i === -1 ? [url, ""] : [url.slice(0, i), url.slice(i)];
}

function originOf(baseNoQuery: string): string {
  const scheme = baseNoQuery.indexOf("://");
  if (scheme === -1) return "";
  const rest = baseNoQuery.slice(scheme + 3);
  const slash = rest.indexOf("/");
  return slash === -1 ? baseNoQuery : baseNoQuery.slice(0, scheme + 3 + slash);
}

function baseDirOf(baseNoQuery: string): string {
  const schemeEnd = (() => {
    const i = baseNoQuery.indexOf("://");
    return i === -1 ? 0 : i + 3;
  })();
  const i = baseNoQuery.lastIndexOf("/");
  return i >= schemeEnd ? baseNoQuery.slice(0, i + 1) : `${baseNoQuery}/`;
}

/**
 * 对应 Rust `resolve_segment`：绝对 URL 原样返回；`/根相对`拼 origin 且丢 base
 * query；相对路径拼 base dir 且继承 base query（分片自带 query 时优先用自己的）。
 */
export function resolve_segment(baseUrl: string, segment: string): string {
  if (segment.startsWith("http://") || segment.startsWith("https://")) {
    return segment;
  }
  const [baseNoQ, baseQ] = splitQuery(baseUrl);
  const [segNoQ, segQ] = splitQuery(segment);
  const query = segQ !== "" ? segQ : baseQ;
  if (segNoQ.startsWith("/")) {
    return `${originOf(baseNoQ)}${segNoQ}${query}`;
  }
  return `${baseDirOf(baseNoQ)}${segNoQ}${query}`;
}

/**
 * 对应 Rust `parse_segments`：含 `EXT-X-KEY` 直接抛错（加密流不支持）；
 * 跳过空行与 `#` 行；相对分片经 `resolve_segment` 展开。
 */
export function parse_segments(baseUrl: string, body: string): string[] {
  if (body.includes("EXT-X-KEY")) {
    throw new Error("加密流不支持：该清晰度为加密分片，暂无法下载");
  }
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    out.push(resolve_segment(baseUrl, line));
  }
  return out;
}

/**
 * 对应 Rust `resolve_target_dir`：`sub_dir` 按 `/` 切分逐段清洗后拼到 `base` 下；
 * 拒绝绝对路径与 `..`，空串即 `base` 本身。
 */
export function resolve_target_dir(base: string, subDir: string): string {
  const s = subDir.trim();
  if (s === "") return base;
  if (s.startsWith("/") || s.startsWith("\\") || path.isAbsolute(s)) {
    throw new Error("子目录不能是绝对路径");
  }
  if (s.length >= 2 && s[1] === ":") {
    throw new Error("子目录不能是绝对路径");
  }
  let dir = base;
  for (const raw of s.split("/")) {
    if (raw.trim() === "") continue;
    if (raw.trim() === "..") throw new Error("子目录不能包含 ..");
    const seg = sanitizeSegment(raw);
    if (seg === "..") throw new Error("子目录不能包含 ..");
    dir = path.join(dir, seg);
  }
  return dir;
}

/**
 * 对应 Rust `unique_mp4_path`：stem 为空→`video`，已存在→` (n)` 后缀。
 * （注：Rust 用 `Path::file_stem` 取 file_name 部分的 stem，`path.parse().name` 语义一致，
 * 含多重后缀 `a.tar.gz`→`a.tar`、dotfile `.mp4`→`.mp4` 等边界。）
 */
export function unique_mp4_path(dir: string, fileName: string): string {
  const stem = path
    .parse(fileName)
    .name.trim()
    .replace(/[/\\]/g, "_");
  const base = stem === "" ? "video" : stem;
  let candidate = path.join(dir, `${base}.mp4`);
  let n = 0;
  while (existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, `${base} (${n}).mp4`);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

/** 对应 Rust `FetchError`：expired 标记签名过期类失败（4xx）。 */
class FetchFailed extends Error {
  expired: boolean;
  detail: string;

  constructor(expired: boolean, detail: string) {
    super(detail);
    this.name = "FetchFailed";
    this.expired = expired;
    this.detail = detail;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOnce(url: string, what: string): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    const timeout =
      (e instanceof DOMException && e.name === "AbortError") ||
      (e instanceof Error && e.name === "AbortError");
    throw new FetchFailed(
      false,
      `${what}${timeout ? "请求超时" : "网络错误"}：${errText(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (resp.ok) {
    try {
      return Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      throw new FetchFailed(false, `${what}读取失败：${errText(e)}`);
    }
  }
  if (resp.status >= 400 && resp.status < 500) {
    throw new FetchFailed(true, `${what}请求被拒（HTTP ${resp.status}）`);
  }
  throw new FetchFailed(false, `${what}服务端异常（HTTP ${resp.status}）`);
}

/** 对应 Rust `fetch_bytes`：FETCH_ATTEMPTS=3 次，`500ms*(attempt-1)` 退避。 */
async function fetch_bytes(url: string, what: string): Promise<Buffer> {
  let last: FetchFailed = new FetchFailed(false, "");
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(500 * (attempt - 1));
    try {
      return await fetchOnce(url, what);
    } catch (e) {
      if (!(e instanceof FetchFailed)) throw e;
      last = e;
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

async function ffmpegFileExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

type ProbeResult = "ok" | "bad" | "missing" | { failed: string };

async function probeFfmpeg(cmd: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["-version"], { stdio: "ignore" });
    child.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") resolve("missing");
      else resolve({ failed: `ffmpeg 自检失败：${errText(e)}` });
    });
    child.on("close", (code) => resolve(code === 0 ? "ok" : "bad"));
  });
}

/**
 * ffmpeg 路径策略：优先 `ffmpeg-static` 自带二进制，其次系统 PATH 的 `ffmpeg`。
 * 自检逻辑保留：二进制存在但 `-version` 非零退出→"ffmpeg 自检失败，请重装 ffmpeg 后再试"。
 * 导出供 local-thumb.ts 复用（本地视频缩略图抽帧）。
 */
export async function findFfmpeg(): Promise<string> {
  // 打包后 ffmpeg-static 返回 app.asar 内路径，spawn 无法执行 asar 内二进制；
  // electron-builder 已将其 asarUnpack，故改写到 app.asar.unpacked。dev 下路径
  // 不含 app.asar，replace 为空操作。
  const raw: string | null = ffmpegStatic;
  const bundled: string | null =
    raw === null || raw === "" ? raw : raw.replace("app.asar", "app.asar.unpacked");
  if (bundled !== null && bundled !== "" && (await ffmpegFileExists(bundled))) {
    const r = await probeFfmpeg(bundled);
    if (r === "ok") return bundled;
    if (r === "bad") throw new Error("ffmpeg 自检失败，请重装 ffmpeg 后再试");
    if (typeof r === "object") throw new Error(r.failed);
  }
  const r = await probeFfmpeg("ffmpeg");
  if (r === "ok") return "ffmpeg";
  if (r === "bad") throw new Error("ffmpeg 自检失败，请重装 ffmpeg 后再试");
  if (typeof r === "object") throw new Error(r.failed);
  throw new Error(FFMPEG_MISSING_MSG);
}

/** 对应 Rust `check_ffmpeg`。 */
async function check_ffmpeg(): Promise<void> {
  await findFfmpeg();
}

/**
 * 对应 Rust `remux`：`ffmpeg -hide_banner -loglevel error -i pipe:0 -c copy <out>`，
 * stdin pipe 喂 blob；stderr 取前 800 字（按字符）。
 */
async function remux(outPath: string, blob: Buffer): Promise<void> {
  const ffmpeg = await findFfmpeg();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-c", "copy", outPath],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    child.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        fail(new Error(FFMPEG_MISSING_MSG));
      } else {
        fail(new Error(`ffmpeg 启动失败：${errText(e)}`));
      }
    });
    child.stderr?.on("data", (c: Buffer | string) => {
      stderrChunks.push(typeof c === "string" ? Buffer.from(c) : Buffer.from(c));
    });
    child.stdin?.on("error", (e) => {
      fail(new Error(`ffmpeg 写入失败：${errText(e)}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      const trimmed = Array.from(
        Buffer.concat(stderrChunks).toString("utf8"),
      )
        .slice(0, 800)
        .join("")
        .trim();
      if (trimmed === "") reject(new Error("ffmpeg 转封装失败"));
      else reject(new Error(`ffmpeg 转封装失败：${trimmed}`));
    });
    child.stdin?.write(blob, (e) => {
      if (e !== null && e !== undefined) {
        fail(new Error(`ffmpeg 写入失败：${errText(e)}`));
        return;
      }
      child.stdin?.end();
    });
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 记账条目：对应 Rust `store::LedgerEntry`。 */
export interface LedgerEntryInput {
  path: string;
  saved_at: number;
  template: string;
}

/**
 * `downloadVideo` 入参：供 Wave 3 接线（严格形状）。
 * - 驼峰命名沿用 `contract.ts` 的 invoke 顶层参数风格；
 * - `userDataDir` 供 Wave 2b 的 store 定位配置与账本；
 * - `emit` 由 Wave 3 接到 `webContents.send`；
 * - `recordLedger` 可选注入：默认用 `./store.js` 的 `recordLedger`，
 *   显式传入时优先（测试与特殊接线的逃生口）。
 */
export interface DownloadVideoOptions {
  m3u8Url: string;
  shareId: string;
  fileId: string;
  fileName: string;
  template: string;
  subDir: string;
  userDataDir: string;
  emit: (event: "download-progress" | "download-done", payload: unknown) => void;
  recordLedger?: (
    userDataDir: string,
    shareId: string,
    fileId: string,
    entry: LedgerEntryInput,
  ) => Promise<void>;
}

/** CLI 覆盖目标目录的环境变量（应用内通常未设置，无影响；CLI 侧由 --target-dir 写入）。 */
const TARGET_DIR_ENV = "FASTCUT_TARGET_DIR";

async function readTargetDir(userDataDir: string): Promise<string> {
  const fromEnv = process.env[TARGET_DIR_ENV]?.trim() ?? "";
  if (fromEnv !== "") return fromEnv;
  const config = await getConfig(userDataDir);
  const dirRaw: string = config?.target_dir ?? "";
  if (dirRaw.trim() === "") {
    throw new Error("未配置目标文件夹，请先在设置页选择下载目录");
  }
  return dirRaw;
}

/** 记账所需最小形状（视频/图片下载入参共享）。 */
interface LedgerCapable {
  userDataDir: string;
  shareId: string;
  fileId: string;
  recordLedger?: DownloadVideoOptions["recordLedger"];
}

async function recordLedgerEntry(
  opts: LedgerCapable,
  entry: LedgerEntryInput,
): Promise<void> {
  const fn = opts.recordLedger ?? recordLedger;
  try {
    await fn(opts.userDataDir, opts.shareId, opts.fileId, entry);
  } catch (e) {
    throw new Error(`记账失败：${errText(e)}`);
  }
}

/** 对应 Rust `run_pipeline`。 */
async function run_pipeline(opts: DownloadVideoOptions): Promise<string> {
  const { m3u8Url, fileId, fileName, template, subDir, userDataDir } = opts;

  const dirRaw = await readTargetDir(userDataDir);
  const dir = resolve_target_dir(dirRaw, subDir);
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    throw new Error(`目标文件夹创建失败：${errText(e)}`);
  }
  const safeName = sanitizeSegment(fileName);
  const outPath = unique_mp4_path(dir, safeName);

  let m3u8Bytes: Buffer;
  try {
    m3u8Bytes = await fetch_bytes(m3u8Url, "m3u8");
  } catch (e) {
    if (e instanceof FetchFailed && e.expired) {
      throw new Error(`${e.detail} EXPIRED：签名可能已过期，请重取链接后重试`);
    }
    throw new Error(e instanceof FetchFailed ? e.detail : errText(e));
  }
  let m3u8Text: string;
  try {
    m3u8Text = new TextDecoder("utf-8", { fatal: true }).decode(m3u8Bytes);
  } catch {
    throw new Error("m3u8 内容解析失败");
  }
  const segments = parse_segments(m3u8Url, m3u8Text);
  if (segments.length === 0) {
    throw new Error("m3u8 中未找到分片");
  }
  const total = segments.length;

  const slots: (Buffer | null)[] = new Array<Buffer | null>(total).fill(null);
  let done = 0;
  const limit = pLimit(SEG_CONCURRENCY);
  await Promise.all(
    segments.map((u, i) =>
      limit(async () => {
        let bytes: Buffer;
        try {
          bytes = await fetch_bytes(u, "分片");
        } catch (e) {
          if (e instanceof FetchFailed) {
            if (e.expired) {
              throw new Error(
                `${e.detail} EXPIRED：签名可能已过期，请重取链接后重试（${done}/${total}）`,
              );
            }
            throw new Error(`${e.detail}（${done}/${total}）`);
          }
          throw e;
        }
        slots[i] = bytes;
        done += 1;
        const payload: DownloadProgressPayload = { file_id: fileId, done, total };
        opts.emit("download-progress", payload);
      }),
    ),
  );

  const parts: Buffer[] = [];
  for (const part of slots) {
    if (part !== null) parts.push(part);
  }
  const blob = Buffer.concat(parts);
  if (blob.length === 0) {
    throw new Error("分片内容为空，下载中止");
  }
  await remux(outPath, blob);

  const savedAt = Math.floor(Date.now() / 1000);
  await recordLedgerEntry(opts, {
    path: outPath,
    saved_at: savedAt,
    template,
  });
  return outPath;
}

/**
 * 对应 Rust `download_video`：异步 fire-and-forget。
 * 空 m3u8 抛错"m3u8 链接为空"；同一 `share_id:file_id` 重入返回 `"downloading"`；
 * 正常返回 `"started"`；结果走 `emit("download-done", {file_id, ok, path?, error?})`。
 */
export async function downloadVideo(opts: DownloadVideoOptions): Promise<string> {
  if (opts.m3u8Url.trim() === "") {
    throw new Error("m3u8 链接为空");
  }
  const key = ledgerKey(opts.shareId, opts.fileId);
  if (inFlight.has(key)) return "downloading";
  inFlight.add(key);
  try {
    await check_ffmpeg();
  } catch (e) {
    inFlight.delete(key);
    throw e;
  }
  void run_pipeline(opts).then(
    (pathStr) => {
      const payload: DownloadDonePayload = {
        file_id: opts.fileId,
        ok: true,
        path: pathStr,
      };
      opts.emit("download-done", payload);
    },
    (e: unknown) => {
      const payload: DownloadDonePayload = {
        file_id: opts.fileId,
        ok: false,
        error: errText(e),
      };
      opts.emit("download-done", payload);
    },
  ).finally(() => {
    inFlight.delete(key);
  });
  return "started";
}

// ---------------------------------------------------------------------------
// 图片直链下载（alipan 图片原图：单文件流式 GET，无需 ffmpeg）
// ---------------------------------------------------------------------------

/** 图片下载单次流超时（原图数 MB，相对分片宽松）。 */
const IMAGE_FETCH_TIMEOUT_MS = 120_000;

/**
 * `unique_image_path`：`unique_mp4_path` 的图片版，保留原后缀
 * （`.jpg/.png/.webp` 等；无/非法后缀则无后缀落盘）。
 * stem 为空→`image`，已存在→` (n)` 后缀。
 */
export function unique_image_path(dir: string, fileName: string): string {
  const parsed = path.parse(fileName);
  const stem = parsed.name.trim().replace(/[/\\]/g, "_");
  const base = stem === "" ? "image" : stem;
  const ext = /^\.[A-Za-z0-9]{1,10}$/.test(parsed.ext) ? parsed.ext : "";
  let candidate = path.join(dir, `${base}${ext}`);
  let n = 0;
  while (existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, `${base} (${n})${ext}`);
  }
  return candidate;
}

/**
 * `downloadImage` 入参与 `DownloadVideoOptions` 同接线形状
 * （`imageUrl` 为 alipan 图片原图直链，`template` 记账固定 `"original"`）。
 */
export interface DownloadImageOptions {
  imageUrl: string;
  shareId: string;
  fileId: string;
  fileName: string;
  subDir: string;
  userDataDir: string;
  emit: (event: "download-progress" | "download-done", payload: unknown) => void;
  recordLedger?: DownloadVideoOptions["recordLedger"];
}

/**
 * 流式拉取单文件：边读边发 `{file_id, done, total}` 进度
 * （total 取 `content-length`，缺失为 0，磁贴仅转圈）。
 * 错误分类与 `fetchOnce` 一致（超时/网络错/4xx-expired/5xx）。
 */
async function fetch_stream(
  url: string,
  what: string,
  fileId: string,
  emit: DownloadImageOptions["emit"],
): Promise<Buffer> {
  let last: FetchFailed = new FetchFailed(false, "");
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(500 * (attempt - 1));
    try {
      return await fetch_stream_once(url, what, fileId, emit);
    } catch (e) {
      if (!(e instanceof FetchFailed)) throw e;
      last = e;
    }
  }
  throw last;
}

async function fetch_stream_once(
  url: string,
  what: string,
  fileId: string,
  emit: DownloadImageOptions["emit"],
): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    const timeout =
      (e instanceof DOMException && e.name === "AbortError") ||
      (e instanceof Error && e.name === "AbortError");
    throw new FetchFailed(
      false,
      `${what}${timeout ? "请求超时" : "网络错误"}：${errText(e)}`,
    );
  }
  if (!resp.ok) {
    clearTimeout(timer);
    if (resp.status >= 400 && resp.status < 500) {
      throw new FetchFailed(true, `${what}请求被拒（HTTP ${resp.status}）`);
    }
    throw new FetchFailed(false, `${what}服务端异常（HTTP ${resp.status}）`);
  }
  const total = Number(resp.headers.get("content-length") ?? "") || 0;
  const reader = resp.body?.getReader();
  // 无流式 body（如测试桩）时整体读取。
  if (reader === undefined) {
    try {
      const buf = Buffer.from(await resp.arrayBuffer());
      clearTimeout(timer);
      return buf;
    } catch (e) {
      clearTimeout(timer);
      throw new FetchFailed(false, `${what}读取失败：${errText(e)}`);
    }
  }
  const chunks: Buffer[] = [];
  let done = 0;
  try {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      const buf = Buffer.from(value);
      chunks.push(buf);
      done += buf.length;
      const payload: DownloadProgressPayload = { file_id: fileId, done, total };
      emit("download-progress", payload);
    }
  } catch (e) {
    throw new FetchFailed(false, `${what}读取失败：${errText(e)}`);
  } finally {
    clearTimeout(timer);
  }
  const blob = Buffer.concat(chunks);
  if (blob.length === 0) {
    throw new FetchFailed(false, `${what}内容为空，下载中止`);
  }
  return blob;
}

/** 图片下载主流程：建目录 → 流式拉取 → 落盘 → 记账（template `"original"`）。 */
async function run_image_pipeline(opts: DownloadImageOptions): Promise<string> {
  const { imageUrl, fileId, fileName, subDir, userDataDir } = opts;

  const dirRaw = await readTargetDir(userDataDir);
  const dir = resolve_target_dir(dirRaw, subDir);
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    throw new Error(`目标文件夹创建失败：${errText(e)}`);
  }
  const safeName = sanitizeSegment(fileName);
  const outPath = unique_image_path(dir, safeName);

  let bytes: Buffer;
  try {
    bytes = await fetch_stream(imageUrl, "图片", fileId, opts.emit);
  } catch (e) {
    if (e instanceof FetchFailed && e.expired) {
      throw new Error(`${e.detail} EXPIRED：签名可能已过期，请重取链接后重试`);
    }
    throw new Error(e instanceof FetchFailed ? e.detail : errText(e));
  }
  try {
    await writeFile(outPath, bytes);
  } catch (e) {
    throw new Error(`图片落盘失败：${errText(e)}`);
  }

  const savedAt = Math.floor(Date.now() / 1000);
  await recordLedgerEntry(opts, {
    path: outPath,
    saved_at: savedAt,
    template: "original",
  });
  return outPath;
}

/**
 * 对应 `download_video` 的图片版：异步 fire-and-forget。
 * 空链接报"图片链接为空"；同一 `share_id:file_id` 重入返回 `"downloading"`；
 * 正常返回 `"started"`；结果走 `emit("download-done", {file_id, ok, path?, error?})`。
 * 与视频共用 `inFlight`（同文件不可能是两种类型）与事件名，
 * 前端进度/完成订阅、磁贴状态机、拖拽均无需改动。
 */
export async function downloadImage(opts: DownloadImageOptions): Promise<string> {
  if (opts.imageUrl.trim() === "") {
    throw new Error("图片链接为空");
  }
  const key = ledgerKey(opts.shareId, opts.fileId);
  if (inFlight.has(key)) return "downloading";
  inFlight.add(key);
  void run_image_pipeline(opts).then(
    (pathStr) => {
      const payload: DownloadDonePayload = {
        file_id: opts.fileId,
        ok: true,
        path: pathStr,
      };
      opts.emit("download-done", payload);
    },
    (e: unknown) => {
      const payload: DownloadDonePayload = {
        file_id: opts.fileId,
        ok: false,
        error: errText(e),
      };
      opts.emit("download-done", payload);
    },
  ).finally(() => {
    inFlight.delete(key);
  });
  return "started";
}

// ---------------------------------------------------------------------------
// 小红书直链下载（M3，仅视频期）
// ---------------------------------------------------------------------------

/** 小红书 sidecar `.meta.json` 落盘形状。 */
export interface XhsSidecar {
  source: "xiaohongshu";
  note_id: string;
  source_url: string;
  title: string;
  author: string;
  cover: string;
  video_url: string;
  file: string;
  downloaded_at: number;
  kind: "video";
}

/** `downloadXhsDirect` 的 meta 入参（note/author/cover 的透传包）。 */
export interface XhsMetaInput {
  noteId?: string;
  note_id?: string;
  author?: string;
  cover?: string;
  title?: string;
  source_url?: string;
  video_url?: string;
}

/**
 * `downloadXhsDirect` 入参：直链 MP4 分支。
 * - `relDir` 为落盘目录相对 `target_dir` 的完整路径（调用方由合集 relDir + 子目录算好传入，优先使用）；
 *   缺省时回退旧语义：`collectionId` 为合集 slug，落盘到 `<target_dir>/collections/<slug>/`；
 * - `subDir` 仅在回退语义下拼到合集目录下（`resolve_target_dir` 语义），`relDir` 存在时忽略；
 * - `fileName` / `title` 决定文件名（`sanitizeTitle` 清洗，无后缀自动补 `.mp4`）；
 * - `meta` + `noteId` / `author` / `cover` / `sourceUrl` 写入同名 sidecar；
 * - `fetchFn` 可注入（单测 mock），默认全局 `fetch`。
 */
export interface DownloadXhsDirectOptions {
  downloadUrl: string;
  collectionId: string;
  relDir?: string;
  subDir?: string;
  fileName?: string;
  title?: string;
  meta?: XhsMetaInput;
  noteId?: string;
  author?: string;
  cover?: string;
  sourceUrl?: string;
  userDataDir: string;
  emit: (event: "download-progress" | "download-done", payload: unknown) => void;
  recordLedger?: (
    userDataDir: string,
    shareId: string,
    fileId: string,
    entry: LedgerEntryInput,
  ) => Promise<void>;
  fetchFn?: typeof fetch;
}

/** 小红书下载的进行中集合（key 见 `xhsInFlightKey`）。 */
const xhsInFlight = new Set<string>();

/** 防重入 key：`xhs:<collectionId>:<basename>`（basename 为清洗后的 stem）。 */
export function xhsInFlightKey(collectionId: string, basename: string): string {
  return `xhs:${collectionId}:${basename}`;
}

export function isXhsDownloading(collectionId: string, basename: string): boolean {
  return xhsInFlight.has(xhsInFlightKey(collectionId, basename));
}

/** 清空小红书在飞集合（单测隔离用）。 */
export function clearXhsInFlight(): void {
  xhsInFlight.clear();
}

function xhsStemOf(opts: DownloadXhsDirectOptions): string {
  const raw = (opts.fileName ?? opts.title ?? opts.noteId ?? "").trim().replace(/\.mp4$/i, "");
  const stem = sanitizeTitle(raw === "" ? "xhs-video" : raw);
  return stem;
}

function xhsMetaOf(opts: DownloadXhsDirectOptions): {
  noteId: string;
  author: string;
  cover: string;
} {
  const noteId =
    opts.noteId ?? opts.meta?.noteId ?? opts.meta?.note_id ?? "";
  const author = opts.author ?? opts.meta?.author ?? "";
  const cover = opts.cover ?? opts.meta?.cover ?? "";
  return { noteId, author, cover };
}

async function fetchXhsOnce(
  fetchFn: typeof fetch,
  url: string,
  what: string,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetchFn(url, { signal: ctrl.signal });
  } catch (e) {
    const timeout =
      (e instanceof DOMException && e.name === "AbortError") ||
      (e instanceof Error && e.name === "AbortError");
    throw new FetchFailed(
      false,
      `${what}${timeout ? "请求超时" : "网络错误"}：${errText(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (resp.ok) return resp;
  if (resp.status >= 400 && resp.status < 500) {
    throw new FetchFailed(true, `${what}请求被拒（HTTP ${resp.status}）`);
  }
  throw new FetchFailed(false, `${what}服务端异常（HTTP ${resp.status}）`);
}

async function fetchXhsWithRetry(
  fetchFn: typeof fetch,
  url: string,
  what: string,
): Promise<Response> {
  let last: FetchFailed = new FetchFailed(false, "");
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(500 * (attempt - 1));
    try {
      return await fetchXhsOnce(fetchFn, url, what);
    } catch (e) {
      if (!(e instanceof FetchFailed)) throw e;
      last = e;
    }
  }
  throw last;
}

/** 对应 `run_pipeline` 的小红书直链版：流式写盘 + sidecar + 记账。 */
async function run_xhs_pipeline(
  opts: DownloadXhsDirectOptions,
  key: string,
  stem: string,
): Promise<string> {
  const collection = opts.collectionId.trim();
  const fetchFn = opts.fetchFn ?? fetch;
  const what = "小红书视频";

  const dirRaw = await readTargetDir(opts.userDataDir);
  // relDir（合集 relDir + 子目录的完整相对路径）优先；缺省回退 collectionId 拼装（兼容旧单测）。
  const dir =
    opts.relDir !== undefined && opts.relDir.trim() !== ""
      ? resolve_target_dir(dirRaw, opts.relDir)
      : (() => {
          const collectionDir = path.join(dirRaw, "collections", sanitizeSegment(collection));
          return resolve_target_dir(collectionDir, opts.subDir ?? "");
        })();
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    throw new Error(`目标文件夹创建失败：${errText(e)}`);
  }
  const outPath = unique_mp4_path(dir, `${stem}.mp4`);
  const basename = path.basename(outPath);
  const { noteId, author, cover } = xhsMetaOf(opts);
  const title = (opts.title ?? opts.meta?.title ?? stem).trim() || stem;
  // 进度事件展示字段（前端虚拟占位用）：落盘名 + 相对目录 + 笔记元信息。
  const relForEvent = path.relative(dirRaw, dir).split(path.sep).join("/");
  const progressMeta = { name: basename, relDir: relForEvent, cover, title };

  let resp: Response;
  try {
    resp = await fetchXhsWithRetry(fetchFn, opts.downloadUrl, what);
  } catch (e) {
    if (e instanceof FetchFailed && e.expired) {
      throw new Error(`${e.detail} EXPIRED：签名可能已过期，请重取链接后重试`);
    }
    throw new Error(e instanceof FetchFailed ? e.detail : errText(e));
  }
  const totalRaw = resp.headers.get("content-length");
  const total = totalRaw !== null && /^\d+$/.test(totalRaw.trim()) ? Number(totalRaw.trim()) : 0;

  const fileId = key;
  let done = 0;
  const body = resp.body;
  if (body === null) {
    // 无流主体时退化为整包读取（仍发一次进度）。
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) throw new Error("下载内容为空，下载中止");
    await writeFile(outPath, buf);
    done = buf.length;
    const payload: DownloadProgressPayload = {
      file_id: fileId,
      done,
      total: total || done,
      ...progressMeta,
    };
    opts.emit("download-progress", payload);
  } else {
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(outPath);
      stream.on("error", (e: Error) => {
        reject(e);
      });
      stream.on("finish", () => {
        resolve();
      });
      void (async () => {
        try {
          for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
            const buf = Buffer.from(chunk);
            if (buf.length === 0) continue;
            if (!stream.write(buf)) {
              await new Promise<void>((r) => stream.once("drain", r));
            }
            done += buf.length;
            const payload: DownloadProgressPayload = { file_id: fileId, done, total, ...progressMeta };
            opts.emit("download-progress", payload);
          }
          stream.end();
        } catch (e) {
          stream.destroy(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });
  }
  if (done === 0) {
    throw new Error("下载内容为空，下载中止");
  }

  const sidecar: XhsSidecar = {
    source: "xiaohongshu",
    note_id: noteId,
    source_url: opts.sourceUrl ?? opts.meta?.source_url ?? "",
    title,
    author,
    cover,
    video_url: opts.downloadUrl,
    file: outPath,
    downloaded_at: Math.floor(Date.now() / 1000),
    kind: "video",
  };
  const metaPath = outPath.replace(/\.mp4$/i, "") + ".meta.json";
  try {
    await writeFile(metaPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  } catch (e) {
    throw new Error(`sidecar 写入失败：${errText(e)}`);
  }

  const fn = opts.recordLedger ?? recordLedger;
  try {
    await fn(opts.userDataDir, `xhs:${collection}`, basename, {
      path: outPath,
      saved_at: Math.floor(Date.now() / 1000),
      template: "xhs",
    });
  } catch (e) {
    throw new Error(`记账失败：${errText(e)}`);
  }
  return outPath;
}

/**
 * 小红书直链下载：fire-and-forget。
 * 空直链抛 `视频直链为空`；同一 `xhs:<collectionId>:<basename>` 重入返回
 * `"downloading"`；正常返回 `"started"`；结果走
 * `emit("download-done", {file_id, ok, path?, error?})`（`file_id` 即防重入 key）。
 */
export async function downloadXhsDirect(opts: DownloadXhsDirectOptions): Promise<string> {
  if (opts.downloadUrl.trim() === "") {
    throw new Error("视频直链为空");
  }
  if (opts.collectionId.trim() === "") {
    throw new Error("合集不能为空");
  }
  const collection = opts.collectionId.trim();
  const stem = xhsStemOf(opts);
  const key = xhsInFlightKey(collection, stem);
  if (xhsInFlight.has(key)) return "downloading";
  xhsInFlight.add(key);
  void run_xhs_pipeline(opts, key, stem).then(
    (pathStr) => {
      const payload: DownloadDonePayload = { file_id: key, ok: true, path: pathStr };
      opts.emit("download-done", payload);
    },
    (e: unknown) => {
      const payload: DownloadDonePayload = { file_id: key, ok: false, error: errText(e) };
      opts.emit("download-done", payload);
    },
  ).finally(() => {
    xhsInFlight.delete(key);
  });
  return "started";
}
