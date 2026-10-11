#!/usr/bin/env node
/**
 * FastCut 独立 Node CLI 入口（不启动 Electron）。
 *
 * 全局 flag（Node 22 内置 `util.parseArgs` 解析）：
 * - `--user-data-dir`：覆盖 userData 目录
 * - `--target-dir`：覆盖下载目标目录（透传给子命令）
 * - `--json`：机器可读输出
 * - `--verbose`：详细日志（走 stderr）
 * - `--help`：打印帮助
 *
 * 环境变量 `FASTCUT_USER_DATA_DIR` / `FASTCUT_TARGET_DIR` 次优先。
 * 渲染结果后 `process.exit(code)`（0 成功、1 用法错误、2 业务失败）。
 */

import type { CliContext, CliResult } from "./lib/context.js";
import { logProgress, renderResult } from "./lib/output.js";
import { TARGET_DIR_ENV, USER_DATA_DIR_ENV, resolveUserDataDir } from "./lib/user-data.js";
import { commands } from "./commands/registry.js";

function globalHelp(): string {
  const lines = [
    "用法: fastcut [全局选项] <命令> [命令参数]",
    "",
    "全局选项:",
    "  --user-data-dir <dir>  覆盖数据目录（优先于 FASTCUT_USER_DATA_DIR）",
    "  --target-dir <dir>     覆盖下载目标目录（优先于 FASTCUT_TARGET_DIR）",
    "  --json                 机器可读 JSON 输出",
    "  --verbose              详细日志（stderr）",
    "  --help                 打印帮助",
    "",
    "命令:",
  ];
  for (const c of commands) {
    lines.push(`  ${c.name}  ${c.describe}`);
    lines.push(`    用法: ${c.usage}`);
  }
  return lines.join("\n");
}

function fail(code: 1 | 2, human: string, error?: string, errorCode?: string): CliResult {
  const out: CliResult = { code, human };
  if (error !== undefined) out.error = error;
  if (errorCode !== undefined) out.errorCode = errorCode;
  return out;
}

/** 手工切分全局参数：全局 flag 只认命令名之前的部分，命令名之后原样透传子命令。 */
interface GlobalParse {
  flagUserDataDir?: string;
  flagTargetDir?: string;
  json: boolean;
  verbose: boolean;
  help: boolean;
  command?: string;
  subArgv: string[];
  error?: string;
}

function takeValue(token: string, rest: string[], i: { n: number }): string | undefined {
  const eq = token.indexOf("=");
  if (eq !== -1) return token.slice(eq + 1);
  const next = rest[i.n + 1];
  if (next === undefined || next === "") return undefined;
  i.n += 1;
  return next;
}

function parseGlobals(raw: string[]): GlobalParse {
  const out: GlobalParse = { json: false, verbose: false, help: false, subArgv: [] };
  const i = { n: 0 };
  while (i.n < raw.length) {
    const t = raw[i.n] as string;
    if (out.command === undefined && t === "--user-data-dir") {
      const v = takeValue(t, raw, i);
      if (v === undefined || v.trim() === "") {
        out.error = "缺少参数：--user-data-dir <dir>";
        return out;
      }
      out.flagUserDataDir = v;
    } else if (out.command === undefined && t.startsWith("--user-data-dir=")) {
      out.flagUserDataDir = t.slice("--user-data-dir=".length);
    } else if (out.command === undefined && t === "--target-dir") {
      const v = takeValue(t, raw, i);
      if (v === undefined || v.trim() === "") {
        out.error = "缺少参数：--target-dir <dir>";
        return out;
      }
      out.flagTargetDir = v;
    } else if (out.command === undefined && t.startsWith("--target-dir=")) {
      out.flagTargetDir = t.slice("--target-dir=".length);
    } else if (out.command === undefined && t === "--json") {
      out.json = true;
    } else if (out.command === undefined && t === "--verbose") {
      out.verbose = true;
    } else if (out.command === undefined && t === "--help") {
      out.help = true;
    } else if (out.command === undefined && t.startsWith("--")) {
      out.error = `未知全局选项：${t}`;
      return out;
    } else if (out.command === undefined) {
      out.command = t;
    } else {
      out.subArgv.push(t);
    }
    i.n += 1;
  }
  return out;
}

async function main(): Promise<{ res: CliResult; asJson: boolean }> {
  const g = parseGlobals(process.argv.slice(2));
  if (g.error !== undefined) {
    return { res: fail(1, `参数解析失败：${g.error}`, g.error, "BAD_USAGE"), asJson: false };
  }
  const { json, verbose, help, command: name, subArgv, flagUserDataDir, flagTargetDir } = g;

  if (help && name === undefined) {
    return { res: { code: 0, human: globalHelp() }, asJson: json };
  }

  if (name === undefined || name.trim() === "") {
    return { res: fail(1, `缺少命令。\n${globalHelp()}`, "缺少命令", "BAD_USAGE"), asJson: json };
  }
  const cmd = commands.find((c) => c.name === name);
  if (cmd === undefined) {
    const known = commands.map((c) => c.name).join("、");
    return {
      res: fail(1, `未知命令：${name}（可用：${known}）`, `未知命令：${name}`, "BAD_USAGE"),
      asJson: json,
    };
  }
  if (help) {
    return { res: { code: 0, human: `${cmd.name}：${cmd.describe}\n用法: ${cmd.usage}` }, asJson: json };
  }

  const targetEnv = process.env[TARGET_DIR_ENV]?.trim();
  const ctx: CliContext = {
    userDataDir: resolveUserDataDir(flagUserDataDir),
    json,
    verbose,
  };
  const override = flagTargetDir ?? (targetEnv !== undefined && targetEnv !== "" ? targetEnv : undefined);
  if (override !== undefined) ctx.targetDirOverride = override;
  // downloader 经 store 读配置（不收 ctx），此处把覆盖值桥进环境变量使其真实生效。
  if (override !== undefined) process.env[TARGET_DIR_ENV] = override;

  if (verbose) {
    logProgress(`[fastcut] userDataDir=${ctx.userDataDir}`);
  }
  if (process.env[USER_DATA_DIR_ENV] !== undefined && verbose) {
    logProgress(`[fastcut] ${USER_DATA_DIR_ENV} 生效中`);
  }

  try {
    return { res: await cmd.run(ctx, subArgv), asJson: json };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (verbose && e instanceof Error && e.stack !== undefined) logProgress(e.stack);
    return { res: fail(2, `执行失败：${msg}`, msg, "FAILED"), asJson: json };
  }
}

const { res, asJson } = await main();
renderResult(res, asJson);
process.exit(res.code);
