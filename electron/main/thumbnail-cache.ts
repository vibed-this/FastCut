/**
 * 缩略图磁盘缓存：服务端快照 URL 只在缺失时下载一次，按 file_id 寻址。
 *
 * - 布局：`<userDataDir>/thumbnails/<shareId>/<fileId>.jpg`（两段均做路径清洗）；
 * - 命中：`localThumbnail` 存在即返回 `media://file/…` URL（复用 index.ts 的本地媒体协议），
 *   顺手 touch atime/mtime 供 LRU 排序；
 * - 预取：`warmThumbnails` 批量下载缺失项（fetch 裸 GET 即可，渲染侧 `<img>` 本就是
 *   `referrerPolicy="no-referrer"`，无需 Referer），并发 6，全程 best-effort，失败跳过；
 * - 上限：默认 200MB（w_256 JPEG 单张约 15–30KB，可存约 7000–13000 张），每次 warm 后 +
 *   App 启动时各 prune 一次，按 atime 从旧到新删到水位线下；另设 20000 文件数兜底。
 * - 失效：只按 file_id（分享源文件极少原地替换内容，滞后可接受；需要时删分享即清其子目录）。
 */
import { readdir, rename, rm, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import pLimit from "p-limit";

import { toLocalMediaUrl } from "../shared/media-url.js";

/** 可注入的抓取函数（net.fetch 与全局 fetch 同形；默认全局 fetch，本模块不 import electron 以便 vitest）。 */
export type ThumbFetch = (url: string) => Promise<{
  ok: boolean;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

function defaultFetch(url: string): Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }> {
  return globalThis.fetch(url);
}

/** 缓存字节上限：默认 200MB。 */
export const THUMB_CACHE_MAX_BYTES = 200 * 1024 * 1024;

/** 文件数兜底上限（防 inode 膨胀，正常到不了）。 */
export const THUMB_CACHE_MAX_FILES = 20000;

/** warm 并发数。 */
export const THUMB_WARM_CONCURRENCY = 6;

const CACHE_DIR = "thumbnails";

/** 路径段清洗：只留字母数字 `.-_`，其余转 `_`，防 `../` 穿出缓存目录。 */
export function sanitizeSegment(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

/** 缓存文件绝对路径（不保证存在）。 */
export function cacheFilePath(userDataDir: string, shareId: string, fileId: string): string {
  return join(
    userDataDir,
    CACHE_DIR,
    sanitizeSegment(shareId),
    `${sanitizeSegment(fileId)}.jpg`,
  );
}

/** 账本绝对路径 → 本地媒体协议 URL（唯一实现见 `../shared/media-url`，此处直接复用）。 */
export function toThumbMediaUrl(absPath: string): string {
  return toLocalMediaUrl(absPath);
}

/**
 * 查本地缓存：存在返回媒体 URL，不存在返回 null。
 * 命中时 touch 时间戳，让 LRU 知道它刚被用过。
 */
export async function localThumbnail(
  userDataDir: string,
  shareId: string,
  fileId: string,
): Promise<string | null> {
  const p = cacheFilePath(userDataDir, shareId, fileId);
  try {
    await stat(p);
  } catch {
    return null;
  }
  const now = new Date();
  try {
    await utimes(p, now, now);
  } catch {
    // touch 失败不影响命中
  }
  return toThumbMediaUrl(p);
}

/**
 * 批量预取：已有跳过（touch 保活），缺失下载；返回本次命中的 fileId → 媒体 URL。
 * 全部 best-effort：单项失败只跳过，不抛。
 */
export async function warmThumbnails(
  userDataDir: string,
  shareId: string,
  entries: { fileId: string; url: string }[],
  fetchImpl: ThumbFetch = defaultFetch,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const limit = pLimit(THUMB_WARM_CONCURRENCY);
  await Promise.all(
    entries.map((e) =>
      limit(async () => {
        if (e.url === "") return;
        const p = cacheFilePath(userDataDir, shareId, e.fileId);
        try {
          await stat(p);
          const now = new Date();
          try {
            await utimes(p, now, now);
          } catch {
            // touch 失败不影响命中
          }
          out[e.fileId] = toThumbMediaUrl(p);
          return;
        } catch {
          // 不存在，继续下载
        }
        try {
          const res = await fetchImpl(e.url);
          if (!res.ok) return;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length === 0) return;
          await mkdir(dirname(p), { recursive: true });
          // 先写临时文件再改名，避免半截文件被读到
          const tmp = join(tmpdir(), `fastcut-thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
          await writeFile(tmp, buf);
          await rename(tmp, p);
          out[e.fileId] = toThumbMediaUrl(p);
        } catch {
          // 下载失败：保持远程兜底
        }
      }),
    ),
  );
  // warm 后顺手 prune，不阻塞返回
  void pruneCache(userDataDir).catch(() => undefined);
  return out;
}

interface CacheEntry {
  path: string;
  size: number;
  atimeMs: number;
}

/**
 * 纯函数：给定文件清单与上限，算出要删的路径（按 atime 从旧到新，
 * 删到字节与文件数双水位线下）。提出来以便单测。
 */
export function planEviction(
  files: CacheEntry[],
  maxBytes: number,
  maxFiles: number,
): string[] {
  const sorted = [...files].sort((a, b) => a.atimeMs - b.atimeMs);
  let bytes = sorted.reduce((s, f) => s + f.size, 0);
  let count = sorted.length;
  const del: string[] = [];
  for (const f of sorted) {
    if (bytes <= maxBytes && count <= maxFiles) break;
    del.push(f.path);
    bytes -= f.size;
    count -= 1;
  }
  return del;
}

/** 按 200MB / 20000 文件水位淘汰旧缓存（best-effort）。 */
export async function pruneCache(userDataDir: string): Promise<void> {
  const root = join(userDataDir, CACHE_DIR);
  let shares: string[] = [];
  try {
    shares = await readdir(root);
  } catch {
    return;
  }
  const files: CacheEntry[] = [];
  for (const sh of shares) {
    let names: string[] = [];
    try {
      names = await readdir(join(root, sh));
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(root, sh, n);
      try {
        const s = await stat(p);
        if (s.isFile()) files.push({ path: p, size: s.size, atimeMs: s.atimeMs });
      } catch {
        // 忽略
      }
    }
  }
  const victims = planEviction(files, THUMB_CACHE_MAX_BYTES, THUMB_CACHE_MAX_FILES);
  await Promise.all(victims.map((p) => rm(p, { force: true }).catch(() => undefined)));
}

/** 删分享时清掉该分享的缩略图子目录（best-effort，不抛）。 */
export async function clearShareThumbnails(userDataDir: string, shareId: string): Promise<void> {
  try {
    await rm(join(userDataDir, CACHE_DIR, sanitizeSegment(shareId)), {
      recursive: true,
      force: true,
    });
  } catch {
    // 忽略
  }
}
