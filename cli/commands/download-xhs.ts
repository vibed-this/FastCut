/**
 * CLI `download xhs` 链路：小红书链接 → 解析 → 拍平落盘。
 *
 * 与主体（合集/记账/sidecar/`downloadXhsDirect`）无关的纯下载：
 * - 不读 `listCollections`，不写 ledger，不写 `.meta.json`；
 * - 解析复用 `XhsClient.parse`（`electron/main/xhs-client.ts`）；
 * - 落盘为本文件内的小函数（fetch 直存 + 重试 + 超时），不引用 `electron/main/index.ts`；
 * - 视频（`videoUrls`，含动态照片 Live）与图文（`images`）拍平混存同一目录，
 *   按序号命名（单文件无序号），扩展名按 URL 启发式 + 响应 content-type 纠正；
 * - 带签名的直链不得进 stdout：human/`data` 仅含本地路径与计数。
 */

import { createWriteStream, promises as fsp } from "node:fs";
import { parseArgs } from "node:util";
import * as path from "node:path";

import { sanitizeTitle, XhsClient, type XhsParseResult } from "../../electron/main/xhs-client.js";
import { detectShareLink } from "../../electron/shared/share-link.js";
import type { CliCommand, CliContext, CliResult } from "../lib/context.js";
import { logProgress } from "../lib/output.js";
import { resolveTargetDir } from "../lib/target.js";

/** 用法行。 */
const USAGE =
  "download xhs <url> [--out <目录>] [--file-name <名>] [--dry-run] [--timeout <秒>]（url 也可用 --url 指定）";

/** `--timeout` 缺省值（秒，整单上限）。 */
const DEFAULT_TIMEOUT_SECS = 120;

/** 单文件 fetch 超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 30_000;

/** 单文件重试次数。 */
const FETCH_ATTEMPTS = 3;

interface DownloadXhsArgs {
  url: string | undefined;
  out: string | undefined;
  fileName: string | undefined;
  dryRun: boolean;
  timeoutSecs: number;
  help: boolean;
}

function usageError(reason: string): CliResult {
  const human: string = `${reason}\n用法：${USAGE}`;
  return { code: 1, human, error: reason, errorCode: "USAGE" };
}

function opError(message: string, errorCode: string): CliResult {
  return { code: 2, human: message, error: message, errorCode };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function cleanFlag(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t: string = v.trim();
  return t === "" ? undefined : t;
}

function parseDownloadXhsArgs(argv: string[]): DownloadXhsArgs {
  const parsed = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      out: { type: "string" },
      "file-name": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const positionals: string[] = parsed.positionals;
  // 首个位置参数为子命令名 xhs（经 download 分发透传），跳过它
  const rest: string[] = positionals[0] === "xhs" ? positionals.slice(1) : positionals;
  if (rest.length > 1) {
    throw new Error(`未知参数：${rest[1]}`);
  }
  const positional: string | undefined = cleanFlag(rest[0]);
  const url: string | undefined = cleanFlag(parsed.values.url);
  if (positional !== undefined && url !== undefined) {
    throw new Error("--url 与位置参数 <url> 互斥，只能给一个");
  }
  let timeoutSecs: number = DEFAULT_TIMEOUT_SECS;
  const timeoutRaw: string | undefined = parsed.values.timeout;
  if (timeoutRaw !== undefined) {
    const n: number = Number(timeoutRaw.trim());
    if (timeoutRaw.trim() === "" || !Number.isFinite(n) || n <= 0) {
      throw new Error(`--timeout 须为正数秒数（当前：${timeoutRaw}）`);
    }
    timeoutSecs = n;
  }
  return {
    url: positional ?? url,
    out: cleanFlag(parsed.values.out),
    fileName: cleanFlag(parsed.values["file-name"]),
    dryRun: parsed.values["dry-run"] ?? false,
    timeoutSecs,
    help: parsed.values.help ?? false,
  };
}

/** 落盘单项（拍平：kind 仅用于扩展名纠正，不分目录）。 */
interface FlatItem {
  url: string;
  kind: "video" | "image";
  fileName: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 按 URL 启发式取扩展名：路径后缀优先，xhscdn 无后缀形（`...?imageView2/.../format/jpg`）
 * 从 query 取 `format/<ext>`，取不到时视频回退 mp4、图片回退 jpg。
 */
export function extFromUrl(url: string, kind: "video" | "image"): string {
  const lower: string = url.toLowerCase();
  const pathM: RegExpMatchArray | null = lower.match(/\.([a-z0-9]{2,4})(?:[?#]|$)/);
  if (pathM !== null) {
    const ext: string = pathM[1] ?? "";
    if (["mp4", "mov"].includes(ext)) return ext;
    if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  }
  const fmtM: RegExpMatchArray | null = lower.match(/format\/(jpg|jpeg|png|webp|gif)/);
  if (fmtM !== null) {
    const f: string = fmtM[1] ?? "";
    return f === "jpeg" ? "jpg" : f;
  }
  return kind === "video" ? "mp4" : "jpg";
}

/** 按响应 content-type 纠正扩展名（取不到时保持启发式结果）。 */
export function extFromContentType(contentType: string | null, fallback: string): string {
  if (contentType === null) return fallback;
  const ct: string = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (ct) {
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return fallback;
  }
}

/**
 * 组拍平落盘计划：视频在前、图片在后；单文件时 `<stem>.<ext>`，
 * 多文件时 `<stem>_01.<ext>` 起按序编号。stem 恒经 `sanitizeTitle`。
 */
export function buildFlatPlan(
  parsed: XhsParseResult,
  fileName: string | undefined,
): Array<{ url: string; kind: "video" | "image"; fileName: string }> {
  const stemRaw: string = (fileName ?? parsed.title ?? parsed.noteId ?? "").trim();
  const stem: string = sanitizeTitle(stemRaw === "" ? "xhs" : stemRaw);
  const raws: Array<{ url: string; kind: "video" | "image" }> = [
    ...parsed.videoUrls.map((url: string) => ({ url, kind: "video" as const })),
    ...parsed.images.map((url: string) => ({ url, kind: "image" as const })),
  ];
  if (raws.length === 1) {
    const only = raws[0] as { url: string; kind: "video" | "image" };
    return [{ ...only, fileName: `${stem}.${extFromUrl(only.url, only.kind)}` }];
  }
  const pad: number = Math.max(2, String(raws.length).length);
  return raws.map((r: { url: string; kind: "video" | "image" }, i: number) => ({
    ...r,
    fileName: `${stem}_${String(i + 1).padStart(pad, "0")}.${extFromUrl(r.url, r.kind)}`,
  }));
}

/** 存在同名时加 `-2/-3` 后缀避让（保留扩展名）。 */
async function uniquePath(dir: string, fileName: string): Promise<string> {
  const ext: string = path.extname(fileName);
  const base: string = fileName.slice(0, fileName.length - ext.length);
  let candidate: string = path.join(dir, fileName);
  for (let i = 2; i < 1000; i++) {
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${base}-${i}${ext}`);
  }
  return candidate;
}

async function fetchOnce(url: string, what: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp: Response = await fetch(url, { signal: ctrl.signal });
    if (resp.ok) return resp;
    if (resp.status >= 400 && resp.status < 500) {
      throw new Error(`${what}请求被拒（HTTP ${resp.status}）`);
    }
    throw new Error(`${what}服务端异常（HTTP ${resp.status}）`);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(`${what}请求超时`);
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** 单文件下载：重试 + content-type 纠正扩展名 + 流式写盘，返回落盘绝对路径。 */
async function downloadOne(dir: string, item: FlatItem, verbose: boolean): Promise<string> {
  const what: string = item.kind === "video" ? "小红书视频" : "小红书图片";
  let lastErr: Error = new Error("下载失败");
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(500 * (attempt - 1));
    try {
      const resp: Response = await fetchOnce(item.url, what);
      const finalExt: string = extFromContentType(
        resp.headers.get("content-type"),
        path.extname(item.fileName).replace(/^\./, "") || (item.kind === "video" ? "mp4" : "jpg"),
      );
      const base: string = item.fileName.replace(/\.[a-z0-9]+$/i, "");
      const outPath: string = await uniquePath(dir, `${base}.${finalExt}`);
      const body = resp.body;
      if (body === null) {
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length === 0) throw new Error("下载内容为空，下载中止");
        await fsp.writeFile(outPath, buf);
      } else {
        await new Promise<void>((resolve, reject) => {
          const stream = createWriteStream(outPath);
          stream.on("error", (e: Error) => reject(e));
          stream.on("finish", () => resolve());
          void (async () => {
            try {
              for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
                const buf = Buffer.from(chunk);
                if (buf.length === 0) continue;
                if (!stream.write(buf)) {
                  await new Promise<void>((r) => stream.once("drain", r));
                }
              }
              stream.end();
            } catch (e) {
              stream.destroy(e instanceof Error ? e : new Error(String(e)));
            }
          })();
        });
      }
      if (verbose) logProgress(`[download] ✓ ${item.fileName} -> ${outPath}`);
      return outPath;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (verbose) logProgress(`[download] 重试 ${attempt}/${FETCH_ATTEMPTS} ${item.fileName}：${lastErr.message}`);
    }
  }
  throw lastErr;
}

/**
 * `download xhs` 入口：argv 为 `download` 之后的参数（含 `xhs`）。
 */
export async function runDownloadXhs(ctx: CliContext, argv: string[]): Promise<CliResult> {
  let args: DownloadXhsArgs;
  try {
    args = parseDownloadXhsArgs(argv);
  } catch (e) {
    return usageError(errMsg(e));
  }
  if (args.help) return { code: 0, human: `用法：${USAGE}` };
  if (args.url === undefined) return usageError("缺少参数：<url>（位置参数或 --url）");
  const detected = detectShareLink(args.url);
  if (detected === null || detected.kind !== "xiaohongshu") {
    return usageError("仅支持小红书链接（xiaohongshu.com / xhslink.com）");
  }
  const url: string = detected.url;

  let parsed: XhsParseResult;
  try {
    parsed = await new XhsClient().parse(url);
  } catch (e) {
    return opError(`解析失败：${errMsg(e)}`, "PARSE_FAILED");
  }
  const plan: FlatItem[] = buildFlatPlan(parsed, args.fileName);
  if (plan.length === 0) return opError("解析结果无可下载文件", "EMPTY_RESULT");

  // 落盘目录：--out 优先，否则走目标目录链（--target-dir/环境/应用配置）
  let outDir: string;
  if (args.out !== undefined) {
    outDir = path.resolve(args.out);
  } else if (args.dryRun) {
    outDir = "<目标目录>";
  } else {
    try {
      outDir = await resolveTargetDir(ctx.userDataDir, ctx.targetDirOverride);
    } catch (e) {
      return opError(errMsg(e), "TARGET_MISSING");
    }
  }

  if (args.dryRun) {
    return {
      code: 0,
      human: [
        `标题：${parsed.title}`,
        `类型：${parsed.kind}（视频 ${parsed.videoUrls.length} / 图片 ${parsed.images.length}）`,
        `目录：${outDir}`,
        ...plan.map((p: FlatItem) => `待下载：${p.fileName}`),
      ].join("\n"),
      data: {
        title: parsed.title,
        kind: parsed.kind,
        noteId: parsed.noteId,
        videoCount: parsed.videoUrls.length,
        imageCount: parsed.images.length,
        outDir,
        files: plan.map((p: FlatItem) => p.fileName),
      },
    };
  }

  try {
    await fsp.mkdir(outDir, { recursive: true });
  } catch (e) {
    return opError(`目标文件夹创建失败：${errMsg(e)}`, "MKDIR_FAILED");
  }

  const deadline: number = Date.now() + Math.floor(args.timeoutSecs * 1000);
  const paths: string[] = [];
  for (const item of plan) {
    if (Date.now() > deadline) return opError("下载超时", "TIMEOUT");
    try {
      paths.push(await downloadOne(outDir, item, ctx.verbose));
    } catch (e) {
      return opError(`下载失败 ${item.fileName}：${errMsg(e)}`, "DOWNLOAD_FAILED");
    }
  }
  return {
    code: 0,
    human: [`✓ 已下载 ${paths.length} 个文件`, `目录：${outDir}`, ...paths].join("\n"),
    data: { title: parsed.title, kind: parsed.kind, noteId: parsed.noteId, outDir, paths },
  };
}

/** `download` 子命令：当前仅 `xhs`（`download xhs <url> …`）。 */
const DOWNLOAD_USAGE = "download xhs <url> [--out <目录>] [--file-name <名>] [--dry-run] [--timeout <秒>]";

async function run(ctx: CliContext, argv: string[]): Promise<CliResult> {
  const head: string | undefined = argv[0]?.trim();
  if (head === undefined || head === "") {
    return { code: 1, human: `缺少参数：xhs\n用法：${DOWNLOAD_USAGE}`, error: "缺少参数：xhs", errorCode: "USAGE" };
  }
  if (head === "--help") return { code: 0, human: `用法：${DOWNLOAD_USAGE}` };
  if (head === "xhs") return runDownloadXhs(ctx, argv);
  return {
    code: 1,
    human: `未知参数：${head}\n用法：${DOWNLOAD_USAGE}`,
    error: `未知参数：${head}`,
    errorCode: "USAGE",
  };
}

export const downloadCommand: CliCommand = {
  name: "download",
  describe: "纯下载：小红书图文/视频直存目录（不经合集）",
  usage: DOWNLOAD_USAGE,
  run,
};
