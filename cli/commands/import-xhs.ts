/**
 * CLI `import xhs` 链路：小红书链接 → 合集定位 → 解析 → 直链落盘。
 *
 * 全部复用主进程既有模块，不复制逻辑：
 * - 合集 `listCollections`（`electron/main/store.ts`）；
 * - 解析 `XhsClient.parse`（`electron/main/xhs-client.ts`，`fetch` 经其构造器注入，便于单测打桩）；
 * - 落盘 `downloadXhsDirect`（`electron/main/downloader.ts`）＋ `waitForDone` 等 `download-done`；
 * - 链接判定 `detectShareLink`（`electron/shared/share-link.ts`）；
 * - 目标目录 `resolveTargetDir`（`cli/lib/target.ts`，缺配置时与现有 `requireTargetDir` 同文案）。
 */

import { parseArgs } from "node:util";

import { downloadXhsDirect, xhsInFlightKey } from "../../electron/main/downloader.js";
import { listCollections } from "../../electron/main/store.js";
import { sanitizeTitle, XhsClient, type XhsParseResult } from "../../electron/main/xhs-client.js";
import type { Collection } from "../../electron/shared/contract.js";
import { detectShareLink } from "../../electron/shared/share-link.js";
import { waitForDone, type DownloadEmit } from "../lib/await-download.js";
import type { CliContext, CliResult } from "../lib/context.js";
import { resolveTargetDir } from "../lib/target.js";

/** 用法行（与 `importCommand` 的 xhs 分支保持一致）。 */
const USAGE =
  "import xhs <url> [--collection <id|name>] [--subdir <合集内相对路径>] [--file-name <名>] [--dry-run] [--timeout <秒>]（url 也可用 --url 指定）";

/** `--timeout` 缺省值（秒）。 */
const DEFAULT_TIMEOUT_SECS = 120;

/** 解析后的命令参数（`parseArgs` 收敛后的强类型形状）。 */
interface XhsArgs {
  url: string | undefined;
  collection: string | undefined;
  sub: string;
  fileName: string | undefined;
  dryRun: boolean;
  timeoutSecs: number;
  help: boolean;
}

/** 合集定位结果（显式区分成功与用法错误）。 */
type CollectionPick = { ok: true; collection: Collection } | { ok: false; result: CliResult };

/** 参数缺失或非法时的用法错误结果（code 1）。 */
function usageError(reason: string): CliResult {
  const human: string = `${reason}\n用法：${USAGE}`;
  return { code: 1, human, error: reason, errorCode: "USAGE" };
}

/** 业务失败结果（code 2）：错误文案透传底层抛出的 message。 */
function opError(message: string, errorCode: string): CliResult {
  return { code: 2, human: message, error: message, errorCode };
}

/** 取 Error 的 message，其余值转字符串。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 空串视为未提供（`--collection ""` 等价于缺省，避免空串污染后续判空）。 */
function cleanFlag(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t: string = v.trim();
  return t === "" ? undefined : t;
}

/** `waitForDone` 超时拒错的判别（其 `code` 为 `"TIMEOUT"`，见 `await-download.ts`）。 */
function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e as { code?: unknown }).code === "TIMEOUT";
}

/**
 * 解析 `import xhs` 之后的参数。
 *
 * @param argv - `import xhs` 之后的参数
 * @returns 收敛后的强类型参数（非法时抛，调用方映射为用法错误）
 */
function parseXhsArgs(argv: string[]): XhsArgs {
  const parsed = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      collection: { type: "string" },
      subdir: { type: "string" },
      "file-name": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const positionals: string[] = parsed.positionals;
  if (positionals.length > 1) {
    throw new Error(`未知参数：${positionals[1]}`);
  }
  const positional: string | undefined = cleanFlag(positionals[0]);
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
    collection: cleanFlag(parsed.values.collection),
    sub: cleanFlag(parsed.values.subdir) ?? "",
    fileName: cleanFlag(parsed.values["file-name"]),
    dryRun: parsed.values["dry-run"] ?? false,
    timeoutSecs,
    help: parsed.values.help ?? false,
  };
}

/**
 * 合集候选行（用法错误提示用）。
 *
 * @param list - 小红书合集
 * @returns `name（id）` 逐行
 */
function candidateLines(list: Collection[]): string {
  return list.map((c: Collection): string => `- ${c.name}（${c.id}）`).join("\n");
}

/**
 * 按 `--collection`（id 或 name 精确匹配）或缺省单合集定位。
 *
 * @param all - 全部合集（含非 xhs，内部过滤）
 * @param want - `--collection` 的值（已 trim，非空）
 * @returns 命中的合集；多/无命中时返回用法错误结果
 */
function pickCollection(all: Collection[], want: string | undefined): CollectionPick {
  const xhs: Collection[] = all.filter((c: Collection): boolean => c.kind === "xiaohongshu");
  if (want !== undefined) {
    const byId: Collection | undefined = xhs.find((c: Collection): boolean => c.id === want);
    if (byId !== undefined) return { ok: true, collection: byId };
    const byName: Collection[] = xhs.filter((c: Collection): boolean => c.name === want);
    if (byName.length === 1) {
      const hit: Collection = byName[0];
      return { ok: true, collection: hit };
    }
    if (byName.length > 1) {
      return {
        ok: false,
        result: usageError(`--collection "${want}" 命中多个合集，请用 id 指定：\n${candidateLines(byName)}`),
      };
    }
    const hint: string = xhs.length === 0 ? "（暂无小红书合集）" : `\n可用合集：\n${candidateLines(xhs)}`;
    return { ok: false, result: usageError(`合集不存在：${want}${hint}`) };
  }
  if (xhs.length === 1) {
    const only: Collection = xhs[0];
    return { ok: true, collection: only };
  }
  if (xhs.length === 0) return { ok: false, result: usageError("暂无小红书合集，请先新建合集") };
  return { ok: false, result: usageError(`合集较多，请用 --collection 指定：\n${candidateLines(xhs)}`) };
}

/**
 * `import xhs` 入口：argv 为 `import xhs` 之后的参数。
 *
 * @param ctx - CLI 上下文
 * @param argv - `import xhs` 之后的参数
 * @returns 执行结果（0 成功、1 用法错误、2 业务失败）
 */
export async function runXhs(ctx: CliContext, argv: string[]): Promise<CliResult> {
  let args: XhsArgs;
  try {
    args = parseXhsArgs(argv);
  } catch (e) {
    return usageError(errMsg(e));
  }
  if (args.help) return { code: 0, human: `用法：${USAGE}` };
  if (args.url === undefined) return usageError("缺少参数：<url>（位置参数或 --url）");
  const detected = detectShareLink(args.url);
  if (detected === null || detected.kind !== "xiaohongshu") {
    return usageError("仅支持小红书链接（xiaohongshu.com / xhslink.com）");
  }
  // 粘贴文本常带尾随标点，用识别出的规范链接往下走
  const url: string = detected.url;

  let all: Collection[];
  try {
    all = await listCollections(ctx.userDataDir);
  } catch (e) {
    return opError(errMsg(e), "COLLECTIONS_FAILED");
  }
  const picked: CollectionPick = pickCollection(all, args.collection);
  if (!picked.ok) return picked.result;
  const collection: Collection = picked.collection;
  const baseRelDir: string = collection.relDir?.trim() ?? "";
  if (baseRelDir === "") return opError("仅小红书合集支持导入", "NOT_XHS_COLLECTION");
  // 与 `electron/main/index.ts` 的 xhs_import 同规则：sub 为空用合集 relDir，已含前缀直接用，否则拼接
  const relDir: string =
    args.sub === "" ? baseRelDir : args.sub.startsWith(baseRelDir) ? args.sub : `${baseRelDir}/${args.sub}`;

  if (!args.dryRun) {
    try {
      await resolveTargetDir(ctx.userDataDir, ctx.targetDirOverride);
    } catch (e) {
      return opError(errMsg(e), "TARGET_MISSING");
    }
  }

  let parsed: XhsParseResult;
  try {
    parsed = await new XhsClient().parse(url);
  } catch (e) {
    return opError(`解析失败：${errMsg(e)}`, "PARSE_FAILED");
  }
  if (args.dryRun) {
    return {
      code: 0,
      human: [
        `标题：${parsed.title}`,
        `作者：${parsed.author}`,
        `封面：${parsed.cover}`,
        `noteId：${parsed.noteId}`,
      ].join("\n"),
      data: parsed,
    };
  }

  const fileNameForDownload: string = args.fileName ?? parsed.title;
  // 与 downloader 内私有 xhsStemOf 同式：fileName 恒有值（缺省即 title），故取值链坍缩为 fileName，再去一次尾部 .mp4，最后 sanitizeTitle
  const stemRaw: string = fileNameForDownload.trim().replace(/\.mp4$/i, "");
  const stem: string = sanitizeTitle(stemRaw === "" ? "xhs-video" : stemRaw);
  const matchFileId: string = xhsInFlightKey(collection.id, stem);

  // 先直调拿到 started/downloading：重入时不再等待——在飞任务的 done 事件只发往首次调用的 emit，等待将超时
  let forward: DownloadEmit<unknown> | undefined;
  let startStatus: string;
  try {
    startStatus = await downloadXhsDirect({
      downloadUrl: parsed.downloadUrl,
      collectionId: collection.id,
      relDir,
      fileName: fileNameForDownload,
      title: parsed.title,
      noteId: parsed.noteId,
      author: parsed.author,
      cover: parsed.cover,
      sourceUrl: url,
      userDataDir: ctx.userDataDir,
      emit: (event, payload) => forward?.(event, payload),
    });
  } catch (e) {
    return opError(errMsg(e), "DOWNLOAD_START_FAILED");
  }
  if (startStatus === "downloading") {
    return {
      code: 0,
      human: `已在下载中：${parsed.title}（${matchFileId}）`,
      data: { title: parsed.title, noteId: parsed.noteId, downloading: true, matchFileId },
    };
  }
  if (startStatus !== "started") return opError(`下载启动异常：${startStatus}`, "DOWNLOAD_START_FAILED");

  const timeoutMs: number = Math.floor(args.timeoutSecs * 1000);
  let outPath: string;
  try {
    // 下载已在上一步启动，此处 starter 只把 waitForDone 的 emit 接入转发，不重复触发下载
    outPath = await waitForDone(
      (emit) => {
        forward = emit;
        return Promise.resolve(startStatus);
      },
      matchFileId,
      { timeoutMs },
    );
  } catch (e) {
    if (isTimeoutError(e)) return opError(errMsg(e), "TIMEOUT");
    return opError(errMsg(e), "DOWNLOAD_FAILED");
  }
  if (outPath.trim() === "") return opError("下载完成但未返回路径", "DOWNLOAD_FAILED");
  // 与 downloader 落盘同式：同名 sidecar
  const sidecar: string = `${outPath.replace(/\.mp4$/i, "")}.meta.json`;
  return {
    code: 0,
    human: `✓ 已导入 ${outPath}\nsidecar：${sidecar}`,
    data: { path: outPath, sidecar, title: parsed.title, noteId: parsed.noteId },
  };
}
