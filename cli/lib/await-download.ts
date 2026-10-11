/**
 * 把 `downloadVideo` / `downloadXhsDirect` 的 fire-and-forget +
 * `emit(event, payload)` 桥成 Promise。
 */

import type {
  DownloadDonePayload,
  DownloadProgressPayload,
} from "../../electron/shared/contract.js";

/** 下载函数接收的 emit 形状（与 `DownloadVideoOptions` / `DownloadXhsDirectOptions` 一致）。 */
export type DownloadEmit<P = unknown> = (
  event: "download-progress" | "download-done",
  payload: P,
) => void;

/** `waitForDone` 的启动函数：调用 fire-and-forget 下载并返回 `"started"` / `"downloading"`。 */
export type DownloadStart<P = unknown> = (emit: DownloadEmit<P>) => Promise<string>;

/** `waitForDone` 可选项。 */
export interface WaitForDoneOpts {
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}

/** 默认超时：30 分钟。 */
export const WAIT_FOR_DONE_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asProgress(v: unknown): DownloadProgressPayload | null {
  if (!isRecord(v)) return null;
  const fileId = v["file_id"];
  const done = v["done"];
  const total = v["total"];
  if (typeof fileId !== "string" || typeof done !== "number" || typeof total !== "number") {
    return null;
  }
  return { file_id: fileId, done, total };
}

function asDone(v: unknown): DownloadDonePayload | null {
  if (!isRecord(v)) return null;
  const fileId = v["file_id"];
  const ok = v["ok"];
  if (typeof fileId !== "string" || typeof ok !== "boolean") return null;
  const out: DownloadDonePayload = { file_id: fileId, ok };
  const path = v["path"];
  const error = v["error"];
  if (typeof path === "string") out.path = path;
  if (typeof error === "string") out.error = error;
  return out;
}

function timeoutError(timeoutMs: number): Error {
  const err = new Error(`TIMEOUT: download timed out after ${timeoutMs}ms`);
  (err as NodeJS.ErrnoException).code = "TIMEOUT";
  return err;
}

/**
 * 启动一次 fire-and-forget 下载并等待其 `download-done[file_id=matchFileId]`。
 * - `ok=true` 则 resolve(path)；
 * - `ok=false` 则 reject(Error(error))；
 * - 超时 reject `TIMEOUT` 错误；
 * - 进度事件经 `opts.onProgress` 回调。
 */
export function waitForDone<T = unknown>(
  start: DownloadStart<T>,
  matchFileId: string,
  opts?: WaitForDoneOpts,
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? WAIT_FOR_DONE_DEFAULT_TIMEOUT_MS;
  const onProgress = opts?.onProgress;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(timeoutError(timeoutMs)));
    }, timeoutMs);

    const emit: DownloadEmit<unknown> = (event, payload) => {
      if (settled) return;
      if (event === "download-progress") {
        const p = asProgress(payload);
        if (p !== null && p.file_id === matchFileId) onProgress?.(p.done, p.total);
        return;
      }
      if (event === "download-done") {
        const d = asDone(payload);
        if (d === null || d.file_id !== matchFileId) return;
        if (d.ok) {
          const path = d.path ?? "";
          finish(() => resolve(path));
        } else {
          const msg = d.error !== undefined && d.error !== "" ? d.error : "下载失败";
          finish(() => reject(new Error(msg)));
        }
      }
    };

    void Promise.resolve()
      .then(() => start(emit))
      .catch((e: unknown) => {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      });
  });
}
