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
 * - ffmpeg 路径策略：优先 `ffmpeg-static` 自带二进制，其次系统 PATH 的 `ffmpeg`，
 *   都找不到才报"未检测到 ffmpeg，请先安装 ffmpeg 后再下载"。自检逻辑保留。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import pLimit from "p-limit";
import ffmpegStatic from "ffmpeg-static";
import type {
  DownloadDonePayload,
  DownloadProgressPayload,
} from "../shared/contract.js";
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
 */
async function findFfmpeg(): Promise<string> {
  const bundled: string | null = ffmpegStatic;
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

async function readTargetDir(userDataDir: string): Promise<string> {
  const config = await getConfig(userDataDir);
  const dirRaw: string = config?.target_dir ?? "";
  if (dirRaw.trim() === "") {
    throw new Error("未配置目标文件夹，请先在设置页选择下载目录");
  }
  return dirRaw;
}

async function recordLedgerEntry(
  opts: DownloadVideoOptions,
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
