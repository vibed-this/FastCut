/**
 * CLI `import` 顶层分发：`argv[0]` 为 `xhs` / `alipan` 时调对应实现并透传余下参数；
 * 其余视为分享 URL，用 `detectShareLink` 判 kind 后智能路由。
 */

import { detectShareLink } from "../../electron/shared/share-link.js";
import type { CliCommand, CliContext, CliResult } from "../lib/context.js";
import { runAlipan } from "./import-alipan.js";
import { runXhs } from "./import-xhs.js";

/** 用法行（`main` 的 `--help` 按此展示）。 */
const USAGE = "import (xhs|alipan) [参数] | import <分享链接> [参数]";

/** 参数缺失或链接无法识别时的用法错误结果（code 1）。 */
function usageError(reason: string): CliResult {
  const human: string = `${reason}\n用法：${USAGE}`;
  return { code: 1, human, error: reason, errorCode: "USAGE" };
}

/**
 * `import` 入口：`xhs` → `runXhs` 余下参数，`alipan` → `runAlipan` 余下参数，
 * 否则把 `argv[0]` 当 URL 识别后路由（整体透传，供子命令取位置参数）。
 *
 * @param ctx - CLI 上下文
 * @param argv - `import` 之后的参数
 * @returns 执行结果（0 成功、1 用法错误、2 业务失败）
 */
async function run(ctx: CliContext, argv: string[]): Promise<CliResult> {
  const headRaw: string | undefined = argv[0];
  const head: string | undefined = headRaw === undefined ? undefined : headRaw.trim();
  if (head === undefined || head === "") {
    return usageError("缺少参数：xhs|alipan|<分享链接>");
  }
  if (head === "--help") return { code: 0, human: `用法：${USAGE}` };
  if (head === "xhs") return runXhs(ctx, argv.slice(1));
  if (head === "alipan") return runAlipan(ctx, argv.slice(1));
  const detected = detectShareLink(head);
  if (detected === null) return usageError(`无法识别的链接：${head}`);
  if (detected.kind === "alipan") return runAlipan(ctx, argv);
  const res: CliResult = await runXhs(ctx, argv);
  if (res.code === 0) return res;
  return {
    ...res,
    human: `${res.human}\n提示：小红书导入需先建 xhs 合集（collection add xhs --name <名称>）`,
  };
}

/** `import` 子命令：`import (xhs|alipan) [参数] | import <分享链接> [参数]`。 */
export const importCommand: CliCommand = {
  name: "import",
  describe: "导入分享：alipan 下载 / 小红书进合集",
  usage: USAGE,
  run,
};
