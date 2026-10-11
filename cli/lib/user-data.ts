/**
 * `userDataDir` 解析：优先级 flag > 环境变量 > 默认值。
 *
 * 默认值按 Electron `app.getPath("userData")` 规则（`<base>/FastCut`）：
 * - darwin: `~/Library/Application Support/FastCut`
 * - win32: `%APPDATA%/FastCut`（无则 `~/AppData/Roaming/FastCut`）
 * - linux: `$XDG_CONFIG_HOME/FastCut`（无则 `~/.config/FastCut`）
 *
 * 路径常量集中在此模块，不散落字面量。
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** 应用名（userData 目录名）。 */
export const APP_NAME = "FastCut";

/** 环境变量：userData 目录覆盖。 */
export const USER_DATA_DIR_ENV = "FASTCUT_USER_DATA_DIR";

/** 环境变量：目标目录覆盖（供 `target.ts` 使用，此处仅收敛声明）。 */
export const TARGET_DIR_ENV = "FASTCUT_TARGET_DIR";

/** darwin 默认基址相对 HOME 的分段。 */
export const DARWIN_USER_DATA_SEGS = ["Library", "Application Support"] as const;

/** win32 无 `%APPDATA%` 时相对 HOME 的分段。 */
export const WIN32_USER_DATA_FALLBACK_SEGS = ["AppData", "Roaming"] as const;

/** linux 无 `$XDG_CONFIG_HOME` 时相对 HOME 的分段。 */
export const LINUX_USER_DATA_FALLBACK_SEGS = [".config"] as const;

function nonEmpty(v: string | undefined): string | null {
  if (v === undefined) return null;
  return v.trim() === "" ? null : v.trim();
}

function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  const h = nonEmpty(env["HOME"]);
  return h ?? homedir();
}

/**
 * 给定平台/环境算出默认 userData 目录。导出以便测试各平台分支。
 */
export function defaultUserDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = homeDir(env);
  if (platform === "darwin") {
    return join(home, ...DARWIN_USER_DATA_SEGS, APP_NAME);
  }
  if (platform === "win32") {
    const roaming = nonEmpty(env["APPDATA"]);
    const base = roaming ?? join(home, ...WIN32_USER_DATA_FALLBACK_SEGS);
    return join(base, APP_NAME);
  }
  const configHome = nonEmpty(env["XDG_CONFIG_HOME"]);
  const base = configHome ?? join(home, ...LINUX_USER_DATA_FALLBACK_SEGS);
  return join(base, APP_NAME);
}

/**
 * 解析 userData 目录：`cliFlag`（`--user-data-dir`）> 环境变量 > 默认值。
 * 空串视为未提供。
 */
export function resolveUserDataDir(cliFlag?: string): string {
  const flag = cliFlag === undefined ? null : nonEmpty(cliFlag);
  if (flag !== null) return flag;
  const fromEnv = nonEmpty(process.env[USER_DATA_DIR_ENV]);
  if (fromEnv !== null) return fromEnv;
  return defaultUserDataDir();
}
