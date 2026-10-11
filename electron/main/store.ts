/**
 * FastCut store 后端（Electron 版）。
 *
 * 落盘路径：`<userDataDir>/fastcut.json`。
 * JSON schema：
 *   `{ config: { target_dir, definition }, ledger: { key: { path, saved_at, template } },
 *      collections: [{ id, kind, name, created_at, share_id?, url?, pwd?, relDir? }] }`
 * 其中 `target_dir` / `pwd` 无值时写 `null`，`created_at` / `saved_at` 为秒级整数。
 * 旧 `shares` 数组仅在读取时做一次性迁移，不再写回。
 * 本模块不 import electron（便于 vitest 测试）。
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AddCollectionInput, AppConfig, Collection, FileStatus } from "../shared/contract.js";
import {
  buildXhsRelDir,
  buildXhsSlug,
  newXhsId,
  randomShortId,
  shortFromXhsId,
  XHS_ROOT,
} from "./collections.js";
import { ShareClient } from "./share-api.js";

export type { AddCollectionInput, AppConfig, Collection, FileStatus };

/** 清晰度档位（与 contract 的 Definition 同构）。 */
export type Definition = "AUTO" | "HD" | "SD";

/** 落盘文件名。 */
export const STORE_FILE = "fastcut.json";

/** 旧应用标识（tauri.conf.json `identifier`），用于迁移路径。 */
export const LEGACY_APP_ID = "com.fastcut.app";

/** 旧分享记录形状：仅读取迁移用，不再写入。 */
export interface LegacySavedShare {
  share_id: string;
  url: string;
  name: string;
  pwd?: string;
  added_at: number;
}

/** 下载落盘记录。 */
export interface LedgerEntry {
  path: string;
  saved_at: number;
  template: string;
}

/** 单文件状态查询结果（含 `file_id`，`state` 小写）。 */
export type StatusState = FileStatus["state"];

/** 内存中的整库数据。`shares` 仅为旧落盘的迁移输入。 */
export interface StoreData {
  config: AppConfig;
  ledger: Record<string, LedgerEntry>;
  collections: Collection[];
  shares?: LegacySavedShare[];
}

/** `isDownloading(shareId, fileId)` 同步判别函数，由 downloader 提供。 */
export type IsDownloadingFn = (shareId: string, fileId: string) => boolean;

/**
 * store 永不 import downloader：`isDownloading` 通过模块级 provider 注入，
 * 默认 `() => false`；main 启动时调用一次 `setIsDownloadingProvider` 完成接线。
 */
let isDownloadingProvider: IsDownloadingFn = () => false;

/** 注册 downloader 提供的 `isDownloading`（main 启动时调用一次）。 */
export function setIsDownloadingProvider(fn: IsDownloadingFn): void {
  isDownloadingProvider = fn;
}

/** 读取当前注册的 `isDownloading`（测试 / 诊断用）。 */
export function getIsDownloadingProvider(): IsDownloadingFn {
  return isDownloadingProvider;
}

/** `addCollection` 的可注入依赖（测试与接线用）。 */
export interface AddCollectionDeps {
  /** 给定 shareId/pwd 返回分享名；默认走 ShareClient。 */
  fetchShareName?: (shareId: string, pwd?: string) => Promise<string>;
}

/** status 查询的可注入依赖（单次覆盖模块级 provider）。 */
export interface StatusDeps {
  isDownloading?: IsDownloadingFn;
}

export function ledgerKey(shareId: string, fileId: string): string {
  return `${shareId}:${fileId}`;
}

/** 秒级整数时间戳。 */
export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function defaultConfig(): AppConfig {
  return { target_dir: undefined, definition: "AUTO" };
}

function defaultStore(): StoreData {
  return { config: defaultConfig(), ledger: {}, collections: [] };
}

/** 大小写不敏感，两端空白忽略。 */
export function normalizeDefinition(raw: string): Definition {
  const v = raw.trim().toUpperCase();
  if (v === "AUTO" || v === "HD" || v === "SD") return v;
  throw new Error("definition 仅支持 AUTO/HD/SD");
}

/** 校验 host / 路径后返回解析好的 URL。错误文案保持不变。 */
export function parseShareUrl(raw: string): URL {
  const url = raw.trim();
  if (url === "") throw new Error("链接不能为空");
  let rest: string | null = null;
  if (url.startsWith("https://")) rest = url.slice("https://".length);
  else if (url.startsWith("http://")) rest = url.slice("http://".length);
  if (rest === null) throw new Error("链接须以 http(s):// 开头");

  let hostEnd = rest.length;
  for (const sep of ["/", "?", "#"] as const) {
    const i = rest.indexOf(sep);
    if (i !== -1 && i < hostEnd) hostEnd = i;
  }
  let host = rest.slice(0, hostEnd).toLowerCase();
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  const hostOk =
    host === "www.alipan.com" ||
    host === "aliyundrive.com" ||
    host.endsWith(".aliyundrive.com");
  if (!hostOk) throw new Error("仅支持 www.alipan.com 或 *.aliyundrive.com 分享链接");

  const afterHost = rest.slice(hostEnd);
  let pathEnd = afterHost.length;
  for (const sep of ["?", "#"] as const) {
    const i = afterHost.indexOf(sep);
    if (i !== -1 && i < pathEnd) pathEnd = i;
  }
  const path = afterHost.slice(0, pathEnd);
  if (!path.startsWith("/s/")) throw new Error("链接路径须以 /s/ 开头");

  try {
    return new URL(url);
  } catch {
    throw new Error("链接解析失败");
  }
}

/** 取 `/s/` 后第一段。 */
export function extractShareId(url: URL): string {
  const pathname = url.pathname;
  if (!pathname.startsWith("/s/")) throw new Error("链接路径须以 /s/ 开头");
  const rest = pathname.slice("/s/".length);
  const id = (rest.split("/")[0] ?? "").trim();
  if (id === "") throw new Error("链接中缺少 share_id");
  return id;
}

function storePath(userDataDir: string): string {
  return join(userDataDir, STORE_FILE);
}

/**
 * 旧数据目录约定（按 bundle identifier 组织）：
 * - darwin: `~/Library/Application Support/<id>/fastcut.json`
 * - win32: `%APPDATA%/<id>/fastcut.json`
 * - linux: `$XDG_DATA_HOME/<id>/fastcut.json`（缺省 `~/.local/share`）
 * 导出以便测试各平台分支。
 */
export function legacyStorePath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const home = env["HOME"] !== undefined && env["HOME"] !== "" ? env["HOME"] : homedir();
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", LEGACY_APP_ID, STORE_FILE);
  }
  if (platform === "win32") {
    const roaming = env["APPDATA"] !== undefined && env["APPDATA"] !== "" ? env["APPDATA"] : null;
    const base = roaming ?? join(home, "AppData", "Roaming");
    return join(base, LEGACY_APP_ID, STORE_FILE);
  }
  if (platform === "linux") {
    const dataHome =
      env["XDG_DATA_HOME"] !== undefined && env["XDG_DATA_HOME"] !== "" ? env["XDG_DATA_HOME"] : null;
    const base = dataHome ?? join(home, ".local", "share");
    return join(base, LEGACY_APP_ID, STORE_FILE);
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseLegacyShare(s: unknown): LegacySavedShare | null {
  if (
    !isRecord(s) ||
    typeof s["share_id"] !== "string" ||
    typeof s["url"] !== "string" ||
    typeof s["name"] !== "string" ||
    typeof s["added_at"] !== "number" ||
    (s["pwd"] !== undefined && s["pwd"] !== null && typeof s["pwd"] !== "string")
  ) {
    return null;
  }
  const item: LegacySavedShare = {
    share_id: s["share_id"],
    url: s["url"],
    name: s["name"],
    added_at: s["added_at"],
  };
  if (typeof s["pwd"] === "string") item.pwd = s["pwd"];
  return item;
}

function parseCollection(c: unknown): Collection | null {
  if (
    !isRecord(c) ||
    typeof c["id"] !== "string" ||
    c["id"].trim() === "" ||
    (c["kind"] !== "alipan" && c["kind"] !== "xiaohongshu") ||
    typeof c["name"] !== "string" ||
    typeof c["created_at"] !== "number"
  ) {
    return null;
  }
  const out: Collection = {
    id: c["id"],
    kind: c["kind"],
    name: c["name"],
    created_at: c["created_at"],
  };
  if (typeof c["share_id"] === "string") out.share_id = c["share_id"];
  if (typeof c["url"] === "string") out.url = c["url"];
  if (typeof c["pwd"] === "string") out.pwd = c["pwd"];
  if (typeof c["relDir"] === "string") out.relDir = c["relDir"];
  return out;
}

function migrateShares(shares: LegacySavedShare[]): Collection[] {
  return shares.map((s) => {
    const out: Collection = {
      id: s.share_id,
      kind: "alipan",
      name: s.name,
      created_at: s.added_at,
      share_id: s.share_id,
      url: s.url,
    };
    if (s.pwd !== undefined) out.pwd = s.pwd;
    return out;
  });
}

/**
 * 宽松解析落盘 JSON：顶层损坏 → 整体空数据；
 * 各节损坏 → 该节取默认。`null` 视为缺省。
 * `collections` 缺失而旧 `shares` 存在时做一次性迁移（alipan，id 复用 share_id）。
 */
function parseStoreData(text: string): StoreData {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return defaultStore();
  }
  if (!isRecord(raw)) return defaultStore();
  const out = defaultStore();

  const config = raw["config"];
  if (isRecord(config)) {
    const targetDir = config["target_dir"];
    if (typeof targetDir === "string") out.config.target_dir = targetDir;
    const definition = config["definition"];
    if (typeof definition === "string") {
      try {
        out.config.definition = normalizeDefinition(definition);
      } catch {
        out.config = defaultConfig();
      }
    } else if (definition !== undefined && definition !== null) {
      out.config = defaultConfig();
    }
  }

  const ledger = raw["ledger"];
  if (isRecord(ledger)) {
    for (const [k, v] of Object.entries(ledger)) {
      if (
        isRecord(v) &&
        typeof v["path"] === "string" &&
        typeof v["saved_at"] === "number" &&
        typeof v["template"] === "string"
      ) {
        out.ledger[k] = { path: v["path"], saved_at: v["saved_at"], template: v["template"] };
      }
    }
  }

  const collections = raw["collections"];
  if (Array.isArray(collections)) {
    for (const c of collections) {
      const item = parseCollection(c);
      if (item !== null) out.collections.push(item);
    }
  } else {
    const shares = raw["shares"];
    if (Array.isArray(shares)) {
      const legacy: LegacySavedShare[] = [];
      for (const s of shares) {
        const item = parseLegacyShare(s);
        if (item !== null) legacy.push(item);
      }
      out.collections = migrateShares(legacy);
    }
  }
  return out;
}

/** 落盘序列化：`target_dir`/`pwd` 的缺省写成 `null`，2 空格缩进。旧 `shares` 不再写回。 */
function serializeStoreData(data: StoreData): string {
  const normalized = {
    config: {
      target_dir: data.config.target_dir ?? null,
      definition: data.config.definition,
    },
    ledger: data.ledger,
    collections: data.collections.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      created_at: c.created_at,
      share_id: c.share_id ?? null,
      url: c.url ?? null,
      pwd: c.pwd ?? null,
      relDir: c.relDir ?? null,
    })),
  };
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

/** 目标文件不存在时，一次性从旧路径拷贝过来。任何失败都静默忽略。 */
async function tryMigrate(target: string): Promise<void> {
  try {
    const legacy = legacyStorePath();
    if (legacy === null || legacy === target) return;
    await mkdir(join(target, ".."), { recursive: true });
    await copyFile(legacy, target);
  } catch {
    // 静默：用空数据
  }
}

async function loadData(userDataDir: string): Promise<StoreData> {
  const path = storePath(userDataDir);
  try {
    return parseStoreData(await readFile(path, "utf8"));
  } catch {
    // 目标不存在（或不可读）：尝试一次性迁移后再读一次
    await tryMigrate(path);
    try {
      return parseStoreData(await readFile(path, "utf8"));
    } catch {
      return defaultStore();
    }
  }
}

async function saveData(userDataDir: string, data: StoreData): Promise<void> {
  const path = storePath(userDataDir);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, serializeStoreData(data), "utf8");
}

/** 默认的分享名查询：经 `./share-api.js` 的 `ShareClient#getShareMeta`。 */
async function defaultFetchShareName(shareId: string, pwd?: string): Promise<string> {
  const meta = await new ShareClient(shareId, pwd).getShareMeta();
  return meta.name;
}

function statusFor(
  data: StoreData,
  shareId: string,
  fileId: string,
  isDownloading: IsDownloadingFn,
): { state: StatusState; path?: string } {
  if (isDownloading(shareId, fileId)) return { state: "downloading" };
  const entry = data.ledger[ledgerKey(shareId, fileId)];
  if (entry !== undefined && existsSync(entry.path)) return { state: "saved", path: entry.path };
  return { state: "none" };
}

function resolveIsDownloading(deps?: StatusDeps): IsDownloadingFn {
  return deps?.isDownloading ?? isDownloadingProvider;
}

/** CLI 覆盖目标目录的环境变量（应用内通常未设置，无影响；CLI 侧由 --target-dir 写入）。 */
const TARGET_DIR_ENV = "FASTCUT_TARGET_DIR";

function requireTargetDir(data: StoreData): string {
  const fromEnv = process.env[TARGET_DIR_ENV]?.trim() ?? "";
  if (fromEnv !== "") return fromEnv;
  const dir = data.config.target_dir?.trim() ?? "";
  if (dir === "") throw new Error("未配置目标文件夹，请先在设置页选择下载目录");
  return dir;
}

export async function getConfig(userDataDir: string): Promise<AppConfig> {
  const data = await loadData(userDataDir);
  return { ...data.config };
}

export async function setConfig(
  userDataDir: string,
  config: { target_dir?: string; definition?: string },
): Promise<void> {
  const data = await loadData(userDataDir);
  if (config.definition !== undefined) {
    data.config.definition = normalizeDefinition(config.definition);
  }
  if (config.target_dir !== undefined) {
    data.config.target_dir = config.target_dir;
  }
  await saveData(userDataDir, data);
}

export async function getStatus(
  userDataDir: string,
  shareId: string,
  fileId: string,
  deps?: StatusDeps,
): Promise<FileStatus> {
  const data = await loadData(userDataDir);
  const { state, path } = statusFor(data, shareId, fileId, resolveIsDownloading(deps));
  const out: FileStatus = { file_id: fileId, state };
  if (path !== undefined) out.path = path;
  return out;
}

export async function getStatusBatch(
  userDataDir: string,
  shareId: string,
  fileIds: string[],
  deps?: StatusDeps,
): Promise<FileStatus[]> {
  const data = await loadData(userDataDir);
  const isDownloading = resolveIsDownloading(deps);
  return fileIds.map((fileId) => {
    const { state, path } = statusFor(data, shareId, fileId, isDownloading);
    const out: FileStatus = { file_id: fileId, state };
    if (path !== undefined) out.path = path;
    return out;
  });
}

export async function listCollections(userDataDir: string): Promise<Collection[]> {
  const data = await loadData(userDataDir);
  return data.collections.map((c) => ({ ...c }));
}

export async function addCollection(
  userDataDir: string,
  input: AddCollectionInput,
  deps?: AddCollectionDeps,
): Promise<Collection> {
  const data = await loadData(userDataDir);
  if (input.kind === "alipan") {
    const trimmed = input.url.trim();
    const parsed = parseShareUrl(trimmed);
    const shareId = extractShareId(parsed);
    const existing = data.collections.find((c) => c.id === shareId);
    if (existing !== undefined) return { ...existing };

    const trimmedPwd = input.pwd?.trim();
    const cleanPwd = trimmedPwd !== undefined && trimmedPwd !== "" ? trimmedPwd : undefined;
    const fetchShareName = deps?.fetchShareName ?? defaultFetchShareName;
    const name = await fetchShareName(shareId, cleanPwd);
    const item: Collection = {
      id: shareId,
      kind: "alipan",
      name,
      created_at: nowSecs(),
      share_id: shareId,
      url: trimmed,
    };
    if (cleanPwd !== undefined) item.pwd = cleanPwd;
    data.collections.push(item);
    await saveData(userDataDir, data);
    return { ...item };
  }

  const clean = input.name.trim();
  if (clean === "") throw new Error("名称不能为空");
  const targetDir = requireTargetDir(data);
  const short = randomShortId();
  const relDir = buildXhsRelDir(clean, short);
  await mkdir(join(targetDir, relDir), { recursive: true });
  const item: Collection = {
    id: newXhsId(short),
    kind: "xiaohongshu",
    name: clean,
    created_at: nowSecs(),
    relDir,
  };
  data.collections.push(item);
  await saveData(userDataDir, data);
  return { ...item };
}

export async function renameCollection(
  userDataDir: string,
  id: string,
  name: string,
): Promise<Collection> {
  const clean = name.trim();
  if (clean === "") throw new Error("名称不能为空");
  const data = await loadData(userDataDir);
  const item = data.collections.find((c) => c.id === id.trim());
  if (item === undefined) throw new Error("合集不存在");
  if (item.kind === "alipan") {
    item.name = clean;
    await saveData(userDataDir, data);
    return { ...item };
  }

  const targetDir = requireTargetDir(data);
  const short = shortFromXhsId(item.id) ?? randomShortId();
  const nextRelDir = `${XHS_ROOT}/${buildXhsSlug(clean, short)}`;
  if (item.relDir === undefined || item.relDir.trim() === "") {
    await mkdir(join(targetDir, nextRelDir), { recursive: true });
    item.relDir = nextRelDir;
    item.name = clean;
    await saveData(userDataDir, data);
    return { ...item };
  }
  if (item.relDir === nextRelDir) {
    item.name = clean;
    await saveData(userDataDir, data);
    return { ...item };
  }
  const oldAbs = join(targetDir, item.relDir);
  const nextAbs = join(targetDir, nextRelDir);
  if (existsSync(nextAbs)) throw new Error("目标已存在");
  if (existsSync(oldAbs)) {
    await rename(oldAbs, nextAbs);
  } else {
    await mkdir(nextAbs, { recursive: true });
  }
  item.relDir = nextRelDir;
  item.name = clean;
  await saveData(userDataDir, data);
  return { ...item };
}

export async function removeCollection(userDataDir: string, id: string): Promise<Collection> {
  const data = await loadData(userDataDir);
  const idx = data.collections.findIndex((c) => c.id === id.trim());
  if (idx === -1) throw new Error("合集不存在");
  const item = data.collections[idx] as Collection;
  if (item.kind === "xiaohongshu" && item.relDir !== undefined && item.relDir.trim() !== "") {
    const fromEnv = process.env[TARGET_DIR_ENV]?.trim() ?? "";
    const targetRaw = fromEnv !== "" ? fromEnv : (data.config.target_dir?.trim() ?? "");
    if (targetRaw !== "") {
      try {
        await rm(join(targetRaw, item.relDir), { recursive: true, force: true });
      } catch (e) {
        throw new Error(`删除磁盘文件夹失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  data.collections.splice(idx, 1);
  await saveData(userDataDir, data);
  return { ...item };
}

/** 供 downloader 调用的落盘记录。 */
export async function recordLedger(
  userDataDir: string,
  shareId: string,
  fileId: string,
  entry: LedgerEntry,
): Promise<void> {
  const data = await loadData(userDataDir);
  data.ledger[ledgerKey(shareId, fileId)] = { ...entry };
  await saveData(userDataDir, data);
}
