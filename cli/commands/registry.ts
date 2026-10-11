/**
 * 子命令注册表：静态聚合顶层命令。
 *
 * - 顶层命令为 `collection` 与 `import`；
 * - `import` 的 run 内部分发 `argv[0]` 为 `xhs` / `alipan` / URL（智能路由），
 *   `xhs` / `alipan` 的具体实现由 `import.ts`（经 `runXhs` / `runAlipan`）提供；
 * - ESM 下相对 import 带 `.js` 后缀（源文件为 `.ts`）。
 */

import type { CliCommand } from "../lib/context.js";
import { collectionCommand } from "../commands/collection.js";
import { importCommand } from "../commands/import.js";

export { collectionCommand, importCommand };

/** 全部顶层子命令（入口按 `name` 分发）。 */
export const commands: CliCommand[] = [collectionCommand, importCommand];
