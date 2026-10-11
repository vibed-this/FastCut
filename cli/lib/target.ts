/**
 * 目标目录解析：优先级 override（`--target-dir`）> 环境变量 >
 * `getConfig(userDataDir).target_dir`（复用 `electron/main/store.ts`）。
 */

import { getConfig } from "../../electron/main/store.js";
import { TARGET_DIR_ENV } from "./user-data.js";

/** 未配置目标文件夹时的错误文案（与现有 `requireTargetDir` 一致）。 */
export const TARGET_DIR_MISSING_MSG = "未配置目标文件夹，请先在设置页选择下载目录";

function nonEmpty(v: string | undefined): string | null {
  if (v === undefined) return null;
  return v.trim() === "" ? null : v.trim();
}

/**
 * 解析下载目标目录。缺失时抛与现有 `requireTargetDir` 一致的错误。
 */
export async function resolveTargetDir(userDataDir: string, override?: string): Promise<string> {
  const fromFlag = override === undefined ? null : nonEmpty(override);
  if (fromFlag !== null) return fromFlag;
  const fromEnv = nonEmpty(process.env[TARGET_DIR_ENV]);
  if (fromEnv !== null) return fromEnv;
  const config = await getConfig(userDataDir);
  const fromConfig = nonEmpty(config.target_dir ?? undefined);
  if (fromConfig !== null) return fromConfig;
  throw new Error(TARGET_DIR_MISSING_MSG);
}
