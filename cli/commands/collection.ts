/**
 * CLI `collection` 子命令：合集的查询、新增、重命名与删除。
 *
 * 直接复用 Electron 主进程的 store 层（`electron/main/store.ts`），以
 * `ctx.userDataDir` 作为数据目录；alipan 合集的 URL 校验与分享名查询同样
 * 复用 store 内部逻辑。alipan 合集删除后 best-effort 清理其缩略图缓存。
 */

import { parseArgs } from "node:util";

import {
  addCollection,
  listCollections,
  removeCollection,
  renameCollection,
} from "../../electron/main/store.js";
import { clearShareThumbnails } from "../../electron/main/thumbnail-cache.js";
import type { Collection } from "../../electron/shared/contract.js";
import type { CliCommand, CliContext, CliResult } from "../lib/context.js";

/** 用法行（与 `collectionCommand.usage` 保持一致）。 */
const USAGE = "collection <list|add|rename|remove> [args]";

/**
 * `add alipan` 分享名查询的可注入依赖。
 *
 * 缺省时 store 走真实网络（`ShareClient`）；测试通过改写
 * `collectionDeps.fetchShareName` 打桩，避免真实网络。
 */
export interface CollectionDeps {
  /** 给定 shareId/pwd 返回分享名。 */
  fetchShareName?: (shareId: string, pwd?: string) => Promise<string>;
}

/** 模块级可注入依赖（见 `CollectionDeps`）。 */
export const collectionDeps: CollectionDeps = {};

/** 参数缺失或未知子命令时的用法错误结果（code 1）。 */
function usageError(reason: string): CliResult {
  const human: string = `${reason}\n用法：${USAGE}`;
  return { code: 1, human, error: reason, errorCode: "USAGE" };
}

/** 业务失败结果（code 2）：错误文案透传 store 抛出的 message。 */
function opError(message: string, errorCode: string): CliResult {
  return { code: 2, human: message, error: message, errorCode };
}

/** 取 Error 的 message，其余值转字符串。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 合集列表渲染为 `id kind name` 行。 */
function renderList(items: Collection[]): string {
  return items.map((c: Collection): string => `${c.id} ${c.kind} ${c.name}`).join("\n");
}

async function runList(ctx: CliContext): Promise<CliResult> {
  try {
    const items: Collection[] = await listCollections(ctx.userDataDir);
    if (items.length === 0) {
      return { code: 0, human: "暂无合集", data: items };
    }
    return { code: 0, human: renderList(items), data: items };
  } catch (e) {
    return opError(errMsg(e), "LIST_FAILED");
  }
}

async function runAddAlipan(
  ctx: CliContext,
  url: string | undefined,
  pwd: string | undefined,
): Promise<CliResult> {
  if (url === undefined) {
    return usageError("缺少参数：--url <url>");
  }
  try {
    const item: Collection = await addCollection(
      ctx.userDataDir,
      pwd === undefined ? { kind: "alipan", url } : { kind: "alipan", url, pwd },
      collectionDeps.fetchShareName === undefined
        ? undefined
        : { fetchShareName: collectionDeps.fetchShareName },
    );
    return { code: 0, human: `已添加合集 ${item.id}（${item.name}）`, data: item };
  } catch (e) {
    return opError(errMsg(e), "ADD_FAILED");
  }
}

async function runAddXhs(ctx: CliContext, name: string | undefined): Promise<CliResult> {
  if (name === undefined) {
    return usageError("缺少参数：--name <name>");
  }
  try {
    const item: Collection = await addCollection(ctx.userDataDir, { kind: "xiaohongshu", name });
    return { code: 0, human: `已添加合集 ${item.id}（${item.name}）`, data: item };
  } catch (e) {
    return opError(errMsg(e), "ADD_FAILED");
  }
}

async function runRename(
  ctx: CliContext,
  id: string | undefined,
  name: string | undefined,
): Promise<CliResult> {
  if (id === undefined) {
    return usageError("缺少参数：--id <id>");
  }
  if (name === undefined) {
    return usageError("缺少参数：--name <新名>");
  }
  try {
    const item: Collection = await renameCollection(ctx.userDataDir, id, name);
    return { code: 0, human: `已重命名合集 ${item.id} 为 ${item.name}`, data: item };
  } catch (e) {
    return opError(errMsg(e), "RENAME_FAILED");
  }
}

async function runRemove(ctx: CliContext, id: string | undefined): Promise<CliResult> {
  if (id === undefined) {
    return usageError("缺少参数：--id <id>");
  }
  try {
    const removed: Collection = await removeCollection(ctx.userDataDir, id);
    if (removed.kind === "alipan") {
      try {
        await clearShareThumbnails(ctx.userDataDir, removed.share_id ?? removed.id);
      } catch {
        // 缩略图清理是 best-effort（复刻 main 现有行为），失败不影响删除结果
      }
    }
    return { code: 0, human: `已删除合集 ${removed.id}（${removed.name}）`, data: removed };
  } catch (e) {
    return opError(errMsg(e), "REMOVE_FAILED");
  }
}

async function run(ctx: CliContext, argv: string[]): Promise<CliResult> {
  let positionals: string[];
  let url: string | undefined;
  let pwd: string | undefined;
  let id: string | undefined;
  let name: string | undefined;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        id: { type: "string" },
        url: { type: "string" },
        pwd: { type: "string" },
        name: { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
    positionals = parsed.positionals;
    if (parsed.values.help === true) {
      return { code: 0, human: `用法：${USAGE}` };
    }
    url = parsed.values.url;
    pwd = parsed.values.pwd;
    id = parsed.values.id;
    name = parsed.values.name;
  } catch (e) {
    return usageError(errMsg(e));
  }

  const sub: string | undefined = positionals[0];
  switch (sub) {
    case "list": {
      if (positionals.length > 1) {
        const extra: string = positionals[1] as string;
        return usageError(`未知参数：${extra}`);
      }
      return runList(ctx);
    }
    case "add": {
      const kind: string | undefined = positionals[1];
      if (kind === undefined) {
        return usageError("缺少参数：add <alipan|xhs>");
      }
      if (kind === "alipan") {
        if (positionals.length > 2) {
          const extra: string = positionals[2] as string;
          return usageError(`未知参数：${extra}`);
        }
        return runAddAlipan(ctx, url, pwd);
      }
      if (kind === "xhs") {
        if (positionals.length > 2) {
          const extra: string = positionals[2] as string;
          return usageError(`未知参数：${extra}`);
        }
        return runAddXhs(ctx, name);
      }
      return usageError(`未知类型：${kind}（仅支持 alipan|xhs）`);
    }
    case "rename": {
      if (positionals.length > 1) {
        const extra: string = positionals[1] as string;
        return usageError(`未知参数：${extra}`);
      }
      return runRename(ctx, id, name);
    }
    case "remove": {
      if (positionals.length > 1) {
        const extra: string = positionals[1] as string;
        return usageError(`未知参数：${extra}`);
      }
      return runRemove(ctx, id);
    }
    default: {
      if (sub === undefined) {
        return usageError("缺少子命令");
      }
      return usageError(`未知子命令：${sub}`);
    }
  }
}

/** `collection` 子命令：`collection <list|add|rename|remove> [args]`。 */
export const collectionCommand: CliCommand = {
  name: "collection",
  describe: "管理合集：查询、新增、重命名与删除",
  usage: USAGE,
  run,
};
