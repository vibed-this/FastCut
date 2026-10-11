/**
 * 本地视频缩略图：ffmpeg 抽一帧 → `<userDataDir>/thumbnails/local/<hash>.jpg`。
 *
 * - 缓存键 = sha256(`absPath|size|mtimeMs`) hex：内容/改名/替换任一变化即新键，
 *   旧文件靠既有 LRU（`pruneCache` 按 atime/双水位淘汰，本目录同样被遍历）自然回收；
 * - 命中：stat 存在即返回 `media://file/…` URL（复用本地媒体协议），顺手 touch 保活；
 * - 生成：`ffmpeg -ss 1 -i <in> -frames:v 1 -vf scale=320:-2 -q:v 5 <out>`，
 *   短视频（不足 1s）`-ss` 取不到帧时回退无 `-ss` 取首帧；单次超时 30s kill；
 * - 预取：`warmLocalVideoThumbnails` 批量处理，ffmpeg 并发 3（CPU 密集别打满），
 *   全程 best-effort：单项失败只跳过，ffmpeg 缺失则整批返回空（不抛）。
 * - 越界防护：relPath 经 `resolveRel` 解析，穿出 targetDir 的直接跳过。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import pLimit from "p-limit";

import { toLocalMediaUrl } from "../shared/media-url.js";
import { findFfmpeg } from "./downloader.js";
import { resolveRel } from "./localfs.js";

/** 本地缩略图子目录（与分享 id 子目录并列，共用 pruneCache 的两层遍历）。 */
export const LOCAL_THUMB_DIR = "local";

/** 缩略图宽度（服务端快照 w_256 对齐，本地取 320 清晰一点）。 */
export const LOCAL_THUMB_WIDTH = 320;

/** 单次 ffmpeg 抽帧超时（ms）。 */
export const SNAPSHOT_TIMEOUT_MS = 30_000;

/** warm 并发数（ffmpeg CPU 密集，取小值）。 */
export const LOCAL_THUMB_WARM_CONCURRENCY = 3;

/**
 * 缓存键：sha256(absPath|size|mtimeMs) hex。
 * 纯函数，提出来以便单测。
 */
export function localThumbKey(absPath: string, size: number, mtimeMs: number): string {
  return createHash("sha256").update(`${absPath}|${size}|${mtimeMs}`).digest("hex");
}

/** 缓存文件绝对路径（不保证存在）。 */
export function localThumbPath(userDataDir: string, key: string): string {
  return join(userDataDir, "thumbnails", LOCAL_THUMB_DIR, `${key}.jpg`);
}

/** 查本地视频缩略图缓存：命中返回媒体 URL，否则 null。 */
export async function localVideoThumbnail(
  userDataDir: string,
  key: string,
): Promise<string | null> {
  const p = localThumbPath(userDataDir, key);
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
  return toLocalMediaUrl(p);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * ffmpeg 抽一帧写 outPath（原子：先写临时文件再改名）。
 * 短视频回退取首帧；超时 kill；输出为空视为失败。成功 resolve，失败 reject。
 */
export function snapshotVideo(
  ffmpeg: string,
  absPath: string,
  outPath: string,
): Promise<void> {
  const baseArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    absPath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${LOCAL_THUMB_WIDTH}:-2`,
    "-q:v",
    "5",
  ];
  // 先 -ss 1（跳过黑场片头），取不到帧再回退首帧
  const attempts: string[][] = [["-ss", "1", ...baseArgs], baseArgs];
  return (async () => {
    let lastErr = "";
    for (const args of attempts) {
      try {
        const tmp = join(
          tmpdir(),
          `fastcut-local-thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
        );
        await runFfmpeg(ffmpeg, args, tmp);
        const s = await stat(tmp).catch(() => null);
        if (s !== null && s.size > 0) {
          await mkdir(dirname(outPath), { recursive: true });
          await rename(tmp, outPath);
          return;
        }
        lastErr = "ffmpeg 未输出缩略图";
      } catch (e) {
        lastErr = errText(e);
      }
    }
    throw new Error(lastErr === "" ? "ffmpeg 抽帧失败" : lastErr);
  })();
}

function runFfmpeg(ffmpeg: string, args: string[], tmpOut: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [...args, tmpOut]);
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg 抽帧超时"));
    }, SNAPSHOT_TIMEOUT_MS);
    timer.unref();
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg 启动失败：${errText(e)}`));
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8").slice(0, 800 - stderr.length);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const tail = stderr.trim().slice(0, 200);
        reject(new Error(tail === "" ? "ffmpeg 抽帧失败" : `ffmpeg 抽帧失败：${tail}`));
      }
    });
  });
}

export interface LocalThumbWarmResult {
  /** 命中的 relPath → 本地媒体 URL（失败项缺席）。 */
  cached: Record<string, string>;
}

/**
 * 批量预取本地视频缩略图：命中直接返回，缺失抽帧生成。
 * relPaths 为 targetDir 下相对路径；目录/不存在/越界/非视频一律跳过（调用方先过滤，本处再按 stat 保底）。
 * ffmpeg 缺失整批返回空，不抛。
 */
export async function warmLocalVideoThumbnails(
  userDataDir: string,
  targetDir: string,
  relPaths: string[],
): Promise<LocalThumbWarmResult> {
  const cached: Record<string, string> = {};
  if (relPaths.length === 0) return { cached };
  let ffmpeg: string;
  try {
    ffmpeg = await findFfmpeg();
  } catch {
    return { cached };
  }
  const limit = pLimit(LOCAL_THUMB_WARM_CONCURRENCY);
  await Promise.all(
    relPaths.map((rel) =>
      limit(async () => {
        let abs: string;
        try {
          abs = resolveRel(targetDir, rel, "路径");
        } catch {
          return;
        }
        let s: { size: number; mtimeMs: number; isFile: () => boolean };
        try {
          const st = await stat(abs);
          if (!st.isFile()) return;
          s = st;
        } catch {
          return;
        }
        const key = localThumbKey(abs, s.size, s.mtimeMs);
        const hit = await localVideoThumbnail(userDataDir, key);
        if (hit !== null) {
          cached[rel] = hit;
          return;
        }
        try {
          await snapshotVideo(ffmpeg, abs, localThumbPath(userDataDir, key));
          const url = await localVideoThumbnail(userDataDir, key);
          if (url !== null) cached[rel] = url;
        } catch {
          // 抽帧失败：保持图标回退
        }
      }),
    ),
  );
  return { cached };
}
