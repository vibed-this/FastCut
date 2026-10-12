/**
 * FastCut store 后端（Electron 版）。
 *
 * 落盘路径：`<userDataDir>/fastcut.json`。
 * JSON schema：
 *   `{ config: { target_dir, definition }, ledger: { key: { path, saved_at, template } },
 *      collections: [{ id, kind, name, created_at, share_id?, url?, pwd?, relDir?, category? }] }`
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
  /** 侧栏分类序（归一化后的分类 key，"" 为未分类）。 */
  category_order: string[];
  /** 侧栏各分类内合集 id 序（key 为归一化分类，"" 为未分类，全量数组语义）。 */
  collection_orders: Record<string, string[]>;
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
  return { config: defaultConfig(), ledger: {}, collections: [], category_order: [], collection_orders: {} };
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
  if (typeof c["category"] === "string" && c["category"].trim() !== "") {
    out.category = c["category"].trim();
  }
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

  const categoryOrder = raw["category_order"];
  if (Array.isArray(categoryOrder)) {
    const seen = new Set<string>();
    for (const k of categoryOrder) {
      if (typeof k !== "string") continue;
      const key = normalizeCategoryKey(k);
      if (seen.has(key)) continue;
      seen.add(key);
      out.category_order.push(key);
    }
  }

  const collectionOrders = raw["collection_orders"];
  if (isRecord(collectionOrders)) {
    for (const [rawKey, v] of Object.entries(collectionOrders)) {
      if (!Array.isArray(v)) continue;
      const key = normalizeCategoryKey(rawKey);
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const id of v) {
        if (typeof id !== "string" || id.trim() === "") continue;
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      if (out.collection_orders[key] === undefined) {
        out.collection_orders[key] = ids;
      } else {
        for (const id of ids) {
          if (!out.collection_orders[key].includes(id)) out.collection_orders[key].push(id);
        }
      }
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
      category: c.category ?? null,
    })),
    category_order: data.category_order ?? [],
    collection_orders: data.collection_orders ?? {},
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

/** 分类名上限（字符数，超长拒绝落盘，保持侧栏可读）。 */
export const CATEGORY_MAX_LENGTH = 32;

/**
 * 归一化分类名：去两端空白，空串视为未分类（undefined）。
 * 超长抛错，调用方透传 message。
 */
export function normalizeCategory(raw?: string): string | undefined {
  if (raw === undefined) return undefined;
  const clean = raw.trim();
  if (clean === "") return undefined;
  if (clean.length > CATEGORY_MAX_LENGTH) {
    throw new Error(`分类名过长（最多${CATEGORY_MAX_LENGTH}字符）`);
  }
  return clean;
}

/** 排序用的分类 key：去两端空白，空即 ""（未分类哨兵）。 */
export function normalizeCategoryKey(raw?: string | null): string {
  if (raw === undefined || raw === null) return "";
  return raw.trim();
}

/** 合集所属的排序 key（category 缺省/空白即 ""）。 */
function categoryKeyOf(c: Collection): string {
  return normalizeCategoryKey(c.category ?? "");
}

/** 字符串数组去重（保留首次出现顺序）。 */
function dedupKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * 按存储序排列合集：order 在先，未知 id 按 created_at 追加尾部。
 * order 中的 stale id 会被忽略，不抛错。
 */
export function getOrderedCollections(collections: Collection[], order: string[]): Collection[] {
  const rank = new Map<string, number>();
  for (const id of dedupKeys(order)) {
    if (!rank.has(id)) rank.set(id, rank.size);
  }
  const inOrder = collections
    .filter((c) => rank.has(c.id))
    .sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number));
  const rest = collections
    .filter((c) => !rank.has(c.id))
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...inOrder, ...rest];
}

/**
 * 按存储序排列分类 key：order 在先，未知分类按字母序追加尾部。
 * 输入可为分类 key 数组，或 Collection 数组（此时先取 distinct key）。
 */
export function getOrderedCategories(
  input: string[] | Collection[],
  order: string[],
): string[] {
  const cats =
    input.length > 0 && typeof input[0] !== "string"
      ? dedupKeys((input as Collection[]).map(categoryKeyOf))
      : dedupKeys((input as string[]).map((k) => normalizeCategoryKey(k)));
  const rank = new Map<string, number>();
  for (const k of dedupKeys(order.map((k) => normalizeCategoryKey(k)))) {
    if (!rank.has(k)) rank.set(k, rank.size);
  }
  const inOrder = cats
    .filter((k) => rank.has(k))
    .sort((a, b) => (rank.get(a) as number) - (rank.get(b) as number));
  const rest = cats
    .filter((k) => !rank.has(k))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  return [...inOrder, ...rest];
}

/** 确保分类 key 在 category_order 尾部（已存在则不动）。 */
function ensureCategoryKey(data: StoreData, key: string): void {
  if (!data.category_order.includes(key)) data.category_order.push(key);
}

/** 合集 id 追加到其分组序尾部（已存在则不动；缺分组时建空分组）。 */
function appendCollectionOrder(data: StoreData, key: string, id: string): void {
  const arr = data.collection_orders[key];
  if (arr === undefined) {
    data.collection_orders[key] = [id];
    return;
  }
  if (!arr.includes(id)) arr.push(id);
}

/** 从分组序中移除 id；分组变空时删分组 key。 */
function removeCollectionOrder(data: StoreData, key: string, id: string): void {
  const arr = data.collection_orders[key];
  if (arr === undefined) return;
  const idx = arr.indexOf(id);
  if (idx !== -1) arr.splice(idx, 1);
  if (arr.length === 0) delete data.collection_orders[key];
}

/** 该分类下是否还有合集；无则从 category_order 剪枝。 */
function pruneCategoryKeyIfEmpty(data: StoreData, key: string): void {
  const stillExists = data.collections.some((c) => categoryKeyOf(c) === key);
  if (!stillExists) {
    const idx = data.category_order.indexOf(key);
    if (idx !== -1) data.category_order.splice(idx, 1);
    if (data.collection_orders[key] !== undefined && data.collection_orders[key].length === 0) {
      delete data.collection_orders[key];
    }
  }
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
    const category = normalizeCategory(input.category);
    if (category !== undefined) item.category = category;
    data.collections.push(item);
    const key = categoryKeyOf(item);
    ensureCategoryKey(data, key);
    appendCollectionOrder(data, key, item.id);
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
  const category = normalizeCategory(input.category);
  if (category !== undefined) item.category = category;
  data.collections.push(item);
  const key = categoryKeyOf(item);
  ensureCategoryKey(data, key);
  appendCollectionOrder(data, key, item.id);
  await saveData(userDataDir, data);
  return { ...item };
}

/**
 * 设置合集分类：空串/缺省即移出分类（未分类）。
 * 分类名去两端空白，超长抛错；id 不存在抛“合集不存在”。
 */
export async function setCollectionCategory(
  userDataDir: string,
  id: string,
  category?: string,
): Promise<Collection> {
  const data = await loadData(userDataDir);
  const item = data.collections.find((c) => c.id === id.trim());
  if (item === undefined) throw new Error("合集不存在");
  const oldKey = categoryKeyOf(item);
  const clean = normalizeCategory(category);
  if (clean === undefined) {
    delete item.category;
  } else {
    item.category = clean;
  }
  const newKey = categoryKeyOf(item);
  if (oldKey !== newKey) {
    removeCollectionOrder(data, oldKey, item.id);
    pruneCategoryKeyIfEmpty(data, oldKey);
    ensureCategoryKey(data, newKey);
    appendCollectionOrder(data, newKey, item.id);
  }
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
  const key = categoryKeyOf(item);
  removeCollectionOrder(data, key, item.id);
  pruneCategoryKeyIfEmpty(data, key);
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

/** 侧栏排序快照（深拷贝，调用方修改不影响落盘）。 */
export async function getSidebarOrders(userDataDir: string): Promise<{
  category_order: string[];
  collection_orders: Record<string, string[]>;
}> {
  const data = await loadData(userDataDir);
  return {
    category_order: [...data.category_order],
    collection_orders: Object.fromEntries(
      Object.entries(data.collection_orders).map(([k, v]) => [k, [...v]]),
    ),
  };
}

/**
 * 分类排序（全量数组语义）：归一化去重后，stale 分类剪枝（"" 保留），
 * 缺失的现存分类追加尾部（非空按字母序，"" 补尾），保存并返回生效序。
 */
export async function reorderCategories(
  userDataDir: string,
  orderedKeys: string[],
): Promise<string[]> {
  const data = await loadData(userDataDir);
  const incoming = dedupKeys(orderedKeys.map((k) => normalizeCategoryKey(k)));
  const existing = dedupKeys(data.collections.map(categoryKeyOf));
  const existingSet = new Set(existing);
  const effective = incoming.filter((k) => k === "" || existingSet.has(k));
  const effectiveSet = new Set(effective);
  const missing = existing.filter((k) => !effectiveSet.has(k));
  const missingNonEmpty = missing.filter((k) => k !== "").sort((a, b) => a.localeCompare(b, "zh-CN"));
  const missingEmpty = missing.filter((k) => k === "");
  data.category_order = [...effective, ...missingNonEmpty, ...missingEmpty];
  await saveData(userDataDir, data);
  return [...data.category_order];
}

/**
 * 同分类内合集排序（全量数组语义）：category 归一化为 key；
 * orderedIds 有跨组或不存在 id 直接抛错；缺失的本组 id 按 created_at 补尾。
 */
export async function reorderCollections(
  userDataDir: string,
  category: string,
  orderedIds: string[],
): Promise<void> {
  const key = normalizeCategoryKey(category);
  const data = await loadData(userDataDir);
  const group = data.collections.filter((c) => categoryKeyOf(c) === key);
  const groupSet = new Set(group.map((c) => c.id));
  const incoming = dedupKeys(orderedIds.map((id) => id.trim()).filter((id) => id !== ""));
  for (const id of incoming) {
    if (!groupSet.has(id)) throw new Error("只能在同分类内排序");
  }
  const incomingSet = new Set(incoming);
  const missing = group
    .filter((c) => !incomingSet.has(c.id))
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => c.id);
  data.collection_orders[key] = [...incoming, ...missing];
  await saveData(userDataDir, data);
}
