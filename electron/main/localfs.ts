/**
 * target_dir 内本地文件操作：列表 / 建目录 / 重命名 / 移动 / 删除。
 * 所有路径均为相对 target_dir 的 relPath（posix `/` 分隔），拒绝绝对路径与 `..`，
 * 解析后越界一律抛错。目标已存在时 rename/move 抛错不覆盖。
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { LocalItem } from "../shared/contract.js";
import { resolve_target_dir } from "./downloader.js";
import { sanitizeSegment } from "./share-api.js";

export type { LocalItem };

function toRelPosix(abs: string, targetDir: string): string {
  return relative(targetDir, abs).split(sep).join("/");
}

/** sidecar 后缀：视频同名 `.meta.json`（视图隐藏，随视频一起移动/重命名/删除）。 */
export const SIDECAR_SUFFIX = ".meta.json";

/** 是否为 sidecar 文件（视图层过滤，文件操作层跟随主文件）。 */
export function isSidecar(name: string): boolean {
  return name.endsWith(SIDECAR_SUFFIX);
}

/**
 * 取视频文件对应的 sidecar 绝对路径（同目录 `<stem>.meta.json`，`stem` 去掉原扩展名）。
 * 不存在返回 null（不抛）。
 */
async function sidecarOf(videoAbs: string): Promise<string | null> {
  const dir = dirname(videoAbs);
  const base = basename(videoAbs);
  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);
  const candidate = join(dir, `${stem}${SIDECAR_SUFFIX}`);
  try {
    const st = await stat(candidate);
    if (st.isFile() && resolve(candidate) !== resolve(videoAbs)) return candidate;
    return null;
  } catch {
    return null;
  }
}

/** 断言相对路径合法：非空可用，拒绝绝对路径、盘符与 `..` 段。 */
function assertRelOk(rel: string, what: string): string {
  const s = rel.trim();
  if (s === "") return "";
  if (isAbsolute(s) || s.startsWith("/") || s.startsWith("\\") || /^[a-zA-Z]:/.test(s)) {
    throw new Error(`${what}不能是绝对路径`);
  }
  for (const seg of s.split("/")) {
    if (seg.trim() === "..") throw new Error(`${what}不能包含 ..`);
  }
  return s;
}

/**
 * 把 relPath 解析为 targetDir 内的绝对路径并断言不越界。
 * 空串指向 targetDir 本身。
 */
export function resolveRel(targetDir: string, relPath: string, what = "路径"): string {
  const base = resolve(targetDir);
  const s = assertRelOk(relPath, what);
  if (s === "") return base;
  const abs = resolve(resolve_target_dir(base, s));
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`${what}越界`);
  }
  return abs;
}

/** 列出 relDir 下一层条目（默认根；`*.meta.json` sidecar 视图隐藏）。 */
export async function fsList(targetDir: string, relDir = ""): Promise<LocalItem[]> {
  const dirAbs = resolveRel(targetDir, relDir, "目录");
  const entries = await readdir(dirAbs, { withFileTypes: true });
  const out: LocalItem[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && isSidecar(e.name)) continue;
    const abs = join(dirAbs, e.name);
    const st = await stat(abs);
    out.push({
      name: e.name,
      relPath: toRelPosix(abs, resolve(targetDir)),
      isDir: e.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtime: Math.floor(st.mtimeMs / 1000),
      absPath: abs,
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** 建目录（mkdir -p）。 */
export async function fsMkdir(targetDir: string, relDir: string): Promise<void> {
  const clean = relDir.trim();
  if (clean === "") throw new Error("目录名不能为空");
  const abs = resolveRel(targetDir, clean, "目录");
  await mkdir(abs, { recursive: true });
}

/** 同目录内重命名为新单段名（目标存在抛错不覆盖；视频文件的 sidecar 跟随改名）。 */
export async function fsRename(
  targetDir: string,
  relPath: string,
  name: string,
): Promise<void> {
  const src = resolveRel(targetDir, relPath, "路径");
  if (src === resolve(targetDir)) throw new Error("不能重命名根目录");
  if (name.trim() === "") throw new Error("名称不能为空");
  if (!existsSync(src)) throw new Error("文件或目录不存在");
  const cleanName = sanitizeSegment(name.trim());
  const dest = join(dirname(src), cleanName);
  if (resolve(dest) === src) return;
  if (existsSync(dest)) throw new Error("目标已存在");
  const st = await stat(src);
  const sidecar = st.isFile() ? await sidecarOf(src) : null;
  await rename(src, dest);
  if (sidecar !== null) {
    const dot = cleanName.lastIndexOf(".");
    const destStem = dot <= 0 ? cleanName : cleanName.slice(0, dot);
    const destSidecar = join(dirname(dest), `${destStem}${SIDECAR_SUFFIX}`);
    if (!existsSync(destSidecar)) {
      await rename(sidecar, destSidecar);
    }
  }
}

/** 移动到目标目录内（保留原名，目标存在抛错不覆盖；视频文件的 sidecar 跟随移动）。 */
export async function fsMove(
  targetDir: string,
  relPath: string,
  destDir: string,
): Promise<void> {
  const base = resolve(targetDir);
  const src = resolveRel(targetDir, relPath, "路径");
  if (src === base) throw new Error("不能移动根目录");
  if (!existsSync(src)) throw new Error("文件或目录不存在");
  const destDirAbs = resolveRel(targetDir, destDir.trim() === "" ? "" : destDir, "目录");
  await mkdir(destDirAbs, { recursive: true });
  if (destDirAbs === src || destDirAbs.startsWith(src + sep)) {
    throw new Error("不能移动到自身或子目录");
  }
  const dest = join(destDirAbs, basename(src));
  if (resolve(dest) === src) return;
  if (existsSync(dest)) throw new Error("目标已存在");
  const st = await stat(src);
  const sidecar = st.isFile() ? await sidecarOf(src) : null;
  await rename(src, dest);
  if (sidecar !== null) {
    const destSidecar = join(destDirAbs, basename(sidecar));
    if (!existsSync(destSidecar)) {
      await rename(sidecar, destSidecar);
    }
  }
}

/** 递归删除（拒绝空路径即根目录；视频文件的 sidecar 跟随删除）。 */
export async function fsRemove(targetDir: string, relPath: string): Promise<void> {
  if (relPath.trim() === "") throw new Error("不能删除根目录");
  const abs = resolveRel(targetDir, relPath, "路径");
  if (abs === resolve(targetDir)) throw new Error("不能删除根目录");
  let isFile = false;
  try {
    isFile = (await stat(abs)).isFile();
  } catch {
    isFile = false;
  }
  const sidecar = isFile ? await sidecarOf(abs) : null;
  await rm(abs, { recursive: true, force: true });
  if (sidecar !== null) {
    await rm(sidecar, { force: true });
  }
}
