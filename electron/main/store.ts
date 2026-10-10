/**
 * FastCut store 后端（Electron 版）。
 *
 * 直译自旧 Tauri 后端 `src-tauri/src/store.rs`（main 分支）。
 * - 落盘路径：`<userDataDir>/fastcut.json`（Wave 3 传入 `app.getPath("userData")`）。
 * - JSON schema 与原来完全一致：
 *   `{ config: { target_dir, definition }, ledger: { key: { path, saved_at, template } },
 *      shares: [{ share_id, url, name, pwd, added_at }] }`
 *   其中 `target_dir` / `pwd` 无值时写 `null`（与 serde `Option::None` 的落盘字节一致），
 *   `saved_at` / `added_at` 为秒级整数。
 * - 本模块不 import electron（便于 vitest 测试），不静态 import
 *   `./share-api.js` / `./downloader.js`（两文件由并行 agent 创建中，
 *   见下方「循环依赖处理」注释）。
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AppConfig, FileStatus } from "../shared/contract.js";
import { ShareClient } from "./share-api.js";

export type { AppConfig, FileStatus };

/** 清晰度档位（与 contract 的 Definition 同构）。 */
export type Definition = "AUTO" | "HD" | "SD";

/** 落盘文件名，与 Rust `STORE_FILE` 一致。 */
export const STORE_FILE = "fastcut.json";

/** 旧 Tauri 应用标识（tauri.conf.json `identifier`），用于迁移路径。 */
export const LEGACY_APP_ID = "com.fastcut.app";

/** 已保存的分享（落盘形状，Rust `SavedShare` 直译：`pwd?`，`added_at` 秒级整数）。 */
export interface SavedShare {
  share_id: string;
  url: string;
  name: string;
  pwd?: string;
  added_at: number;
}

/** 下载落盘记录（Rust `LedgerEntry` 直译）。 */
export interface LedgerEntry {
  path: string;
  saved_at: number;
  template: string;
}

/** 单文件状态查询结果（contract `FileStatus`：含 `file_id`，`state` 小写）。 */
export type StatusState = FileStatus["state"];

/** 内存中的整库数据（Rust `StoreData` 直译）。 */
export interface StoreData {
  config: AppConfig;
  ledger: Record<string, LedgerEntry>;
  shares: SavedShare[];
}

/** `isDownloading(shareId, fileId)` 同步判别函数，由 downloader 提供。 */
export type IsDownloadingFn = (shareId: string, fileId: string) => boolean;

/**
 * 循环依赖处理方案（ESM 下静态互 import 可用，但两个对端文件尚不存在，
 * 静态 import 会直接导致 vitest/tsc 解析失败）：
 * - store **永不 import downloader**：`isDownloading` 通过模块级 provider 注入，
 *   默认 `() => false`；downloader 就绪后由 Wave 3 在启动时调用一次
 *   `setIsDownloadingProvider(isDownloading)` 完成接线；各 status 查询函数也接受
 *   可选的单次覆盖参数。
 * - downloader 只 import store 的 `recordLedger` / `ledgerKey`（单向依赖，无环）。
 * - `addShare` 默认用 `./share-api.js` 的 `ShareClient#getShareMeta` 取名，
 *   测试与特殊接线可经 `AddShareDeps.fetchShareName` 注入覆盖。
 */
let isDownloadingProvider: IsDownloadingFn = () => false;

/** 注册 downloader 提供的 `isDownloading`（Wave 3 在 main 启动时调用一次）。 */
export function setIsDownloadingProvider(fn: IsDownloadingFn): void {
  isDownloadingProvider = fn;
}

/** 读取当前注册的 `isDownloading`（测试 / 诊断用）。 */
export function getIsDownloadingProvider(): IsDownloadingFn {
  return isDownloadingProvider;
}

/** `addShare` 的可注入依赖（测试与 Wave 3 接线用）。 */
export interface AddShareDeps {
  /** 给定 shareId/pwd 返回分享名；默认走动态 import 的 ShareClient。 */
  fetchShareName?: (shareId: string, pwd?: string) => Promise<string>;
}

/** status 查询的可注入依赖（单次覆盖模块级 provider）。 */
export interface StatusDeps {
  isDownloading?: IsDownloadingFn;
}

export function ledgerKey(shareId: string, fileId: string): string {
  return `${shareId}:${fileId}`;
}

/** 秒级整数时间戳（Rust `now_secs` 直译）。 */
export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function defaultConfig(): AppConfig {
  return { target_dir: undefined, definition: "AUTO" };
}

function defaultStore(): StoreData {
  return { config: defaultConfig(), ledger: {}, shares: [] };
}

/** Rust `normalize_definition` 直译（大小写不敏感，两端空白忽略）。 */
export function normalizeDefinition(raw: string): Definition {
  const v = raw.trim().toUpperCase();
  if (v === "AUTO" || v === "HD" || v === "SD") return v;
  throw new Error("definition 仅支持 AUTO/HD/SD");
}

/**
 * Rust `parse_share_url` 直译：校验 host / 路径后返回解析好的 URL。
 * 错误文案逐字保留。
 */
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

/** Rust `extract_share_id` 直译：取 `/s/` 后第一段。 */
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
 * 旧 Tauri `app_data_dir` 约定（Tauri v2，按 bundle identifier 组织）：
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

/**
 * 宽松解析落盘 JSON：顶层损坏 → 整体空数据（对标 serde `unwrap_or_default`）；
 * 各节损坏 → 该节取默认（`#[serde(default)]` 语义）。`null` 视为缺省。
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

  const shares = raw["shares"];
  if (Array.isArray(shares)) {
    for (const s of shares) {
      if (
        isRecord(s) &&
        typeof s["share_id"] === "string" &&
        typeof s["url"] === "string" &&
        typeof s["name"] === "string" &&
        typeof s["added_at"] === "number" &&
        (s["pwd"] === undefined || s["pwd"] === null || typeof s["pwd"] === "string")
      ) {
        const item: SavedShare = {
          share_id: s["share_id"],
          url: s["url"],
          name: s["name"],
          added_at: s["added_at"],
        };
        if (typeof s["pwd"] === "string") item.pwd = s["pwd"];
        out.shares.push(item);
      }
    }
  }
  return out;
}

/** 落盘序列化：`target_dir`/`pwd` 的缺省写成 `null`（与 serde 落盘字节一致），2 空格缩进。 */
function serializeStoreData(data: StoreData): string {
  const normalized = {
    config: {
      target_dir: data.config.target_dir ?? null,
      definition: data.config.definition,
    },
    ledger: data.ledger,
    shares: data.shares.map((s) => ({
      share_id: s.share_id,
      url: s.url,
      name: s.name,
      pwd: s.pwd ?? null,
      added_at: s.added_at,
    })),
  };
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

/**
 * 迁移：目标文件不存在时，一次性从旧 Tauri 路径拷贝过来。
 * 任何失败（无旧文件、无权限等）都静默忽略，调用方继续用空数据。
 */
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

/** 默认的分享名查询：经 `./share-api.js` 的 `ShareClient#getShareMeta`（直译 Rust `get_share_by_anonymous` 取名）。 */
async function defaultFetchShareName(shareId: string, pwd?: string): Promise<string> {
  const meta = await new ShareClient(shareId, pwd).getShareMeta();
  return meta.name;
}

/** Rust `status_for` 直译。 */
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

export async function listShares(userDataDir: string): Promise<SavedShare[]> {
  const data = await loadData(userDataDir);
  return data.shares.map((s) => ({ ...s }));
}

export async function addShare(
  userDataDir: string,
  url: string,
  pwd?: string,
  deps?: AddShareDeps,
): Promise<SavedShare> {
  const trimmed = url.trim();
  const parsed = parseShareUrl(trimmed);
  const shareId = extractShareId(parsed);
  const data = await loadData(userDataDir);
  const existing = data.shares.find((s) => s.share_id === shareId);
  if (existing !== undefined) return { ...existing };

  const trimmedPwd = pwd?.trim();
  const cleanPwd = trimmedPwd !== undefined && trimmedPwd !== "" ? trimmedPwd : undefined;
  const fetchShareName = deps?.fetchShareName ?? defaultFetchShareName;
  const name = await fetchShareName(shareId, cleanPwd);
  const item: SavedShare = { share_id: shareId, url: trimmed, name, added_at: nowSecs() };
  if (cleanPwd !== undefined) item.pwd = cleanPwd;
  data.shares.push(item);
  await saveData(userDataDir, data);
  return { ...item };
}

export async function renameShare(
  userDataDir: string,
  shareId: string,
  name: string,
): Promise<SavedShare> {
  const clean = name.trim();
  if (clean === "") throw new Error("名称不能为空");
  const data = await loadData(userDataDir);
  const item = data.shares.find((s) => s.share_id === shareId.trim());
  if (item === undefined) throw new Error("分享不存在");
  item.name = clean;
  await saveData(userDataDir, data);
  return { ...item };
}

export async function removeShare(userDataDir: string, shareId: string): Promise<void> {
  const data = await loadData(userDataDir);
  const before = data.shares.length;
  data.shares = data.shares.filter((s) => s.share_id !== shareId.trim());
  if (data.shares.length === before) throw new Error("分享不存在");
  await saveData(userDataDir, data);
}

/** 供 downloader 调用的落盘记录（Rust `record_ledger` 直译）。 */
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
