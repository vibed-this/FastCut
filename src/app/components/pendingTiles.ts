/**
 * 下载中虚拟占位与缩略图进度叠加的纯逻辑（无 UI 依赖，可单测）。
 *
 * 背景：小红书导入是本地落盘，下载完成前磁盘上没有文件，
 * `fs_list` 刷不出条目，进度只能落在 `explorer.progress` 里
 *（key 为 `xhs:<collectionId>:<stem>`，与真实条目的 `relPath` 对不上）。
 * 因此把“无对应真实条目的进度项”挑出来渲染成虚拟磁贴占位，
 * 落盘刷新后（同名真实条目出现）占位自动退场。
 */
import type { ExplorerProgress } from "../store";

/** 虚拟占位磁贴（key 即进度 file_id，name 为展示名）。 */
export interface XhsPendingTile {
  key: string;
  progress: ExplorerProgress;
  name: string;
}

/** 小红书进度 key 前缀（见 `xhsInFlightKey`）。 */
export function xhsProgressKeyPrefix(collectionId: string): string {
  return `xhs:${collectionId}:`;
}

/** 占位展示名：落盘名优先，其次标题 + `.mp4`，否则回退“下载中…”。 */
export function pendingDisplayName(p: ExplorerProgress): string {
  const name = p.name?.trim() ?? "";
  if (name !== "") return name;
  const title = p.title?.trim() ?? "";
  if (title !== "") return `${title}.mp4`;
  return "下载中…";
}

/**
 * 从进度映射中挑出当前小红书目录的虚拟占位项。
 *
 * @param progress - `explorer.progress` 全量映射
 * @param collectionId - 当前合集 id（只收 `xhs:<id>:` 前缀）
 * @param currentRelDir - 当前浏览目录（相对 `target_dir` 完整路径）
 * @param existingNames - 当前目录已有的真实文件名（含后缀，用于去重退场）
 * @returns 按 key 稳定排序的占位项
 */
export function selectXhsPending(
  progress: Record<string, ExplorerProgress> | undefined,
  collectionId: string,
  currentRelDir: string,
  existingNames: ReadonlySet<string>,
): XhsPendingTile[] {
  if (progress === undefined) return [];
  const prefix = xhsProgressKeyPrefix(collectionId);
  const out: XhsPendingTile[] = [];
  for (const [key, p] of Object.entries(progress)) {
    if (!key.startsWith(prefix)) continue;
    // 带 relDir 的事件只在落盘目录展示；缺字段（旧载荷）时为兼容仍展示。
    if (p.relDir !== undefined && p.relDir !== currentRelDir) continue;
    const name = pendingDisplayName(p);
    // 真实文件已落盘（同名）则占位退场，避免重复磁贴。
    if (existingNames.has(name)) continue;
    out.push({ key, progress: p, name });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** 进度百分比：`total <= 0` 时为 null（总量未知，改展示已下载字节）。 */
export function progressPercent(done: number, total: number): number | null {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** 字节数 → 可读文案（总量未知时的进度信息用）。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const unit = units[u] ?? "KB";
  return `${v >= 100 ? Math.round(v).toString() : v.toFixed(1)} ${unit}`;
}
