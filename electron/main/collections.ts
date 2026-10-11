/**
 * 合集纯函数：短 id 生成与小红书合集 slug 装配。
 * 无文件系统副作用，store 负责落盘与建目录。
 */
import { randomBytes } from "node:crypto";

import { sanitizeSegment } from "./share-api.js";

/** 小红书合集 id 前缀。 */
export const XHS_ID_PREFIX = "xhs_";

/** 小红书合集磁盘根（相对 target_dir）。 */
export const XHS_ROOT = "collections";

/** 生成 8 位十六进制短 id。 */
export function randomShortId(): string {
  return randomBytes(4).toString("hex");
}

/** 生成小红书合集 id（`xhs_<短id>`，与 alipan share_id 形状不重叠）。 */
export function newXhsId(short = randomShortId()): string {
  return `${XHS_ID_PREFIX}${short}`;
}

/** 装配小红书合集 slug：`sanitizeSegment(name)-<短id>`。 */
export function buildXhsSlug(name: string, short = randomShortId()): string {
  return `${sanitizeSegment(name)}-${short}`;
}

/** 装配小红书合集 relDir（相对 target_dir，posix 风格）。 */
export function buildXhsRelDir(name: string, short = randomShortId()): string {
  return `${XHS_ROOT}/${buildXhsSlug(name, short)}`;
}

/** 从小红书合集 id 提取短 id 后缀（取不到返回 null）。 */
export function shortFromXhsId(id: string): string | null {
  if (!id.startsWith(XHS_ID_PREFIX)) return null;
  const short = id.slice(XHS_ID_PREFIX.length).trim();
  return short === "" ? null : short;
}
