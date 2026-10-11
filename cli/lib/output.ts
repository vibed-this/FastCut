/**
 * 结果渲染：人类可读行走 stdout，`--json` 时 stdout 只打一个 JSON；
 * 进度/日志一律走 stderr。
 */

import type { CliResult } from "./context.js";

/** 进度/日志输出到 stderr（不污染 stdout 的人类可读行 / JSON）。 */
export function logProgress(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * 渲染命令结果。
 * - 默认：stdout 打人类可读行（`res.human`，多行按 `\n` 切分逐行输出）；
 * - `asJson`：stdout 只打一个 JSON `{"ok":true/false,...}`。
 */
export function renderResult(res: CliResult, asJson: boolean): void {
  if (!asJson) {
    for (const line of res.human.split("\n")) {
      process.stdout.write(`${line}\n`);
    }
    return;
  }
  const body: Record<string, unknown> = { ok: res.code === 0 };
  if (res.data !== undefined) body["data"] = res.data;
  if (res.error !== undefined) body["error"] = res.error;
  if (res.errorCode !== undefined) body["errorCode"] = res.errorCode;
  else if (res.code !== 0) body["errorCode"] = "FAILED";
  if (res.code === 0 && res.human !== "") body["message"] = res.human;
  process.stdout.write(`${JSON.stringify(body)}\n`);
}
