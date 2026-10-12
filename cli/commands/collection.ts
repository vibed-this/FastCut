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
  getSidebarOrders,
  listCollections,
  removeCollection,
  renameCollection,
  reorderCollections,
  setCollectionCategory,
} from "../../electron/main/store.js";
import { clearShareThumbnails } from "../../electron/main/thumbnail-cache.js";
import type { Collection } from "../../electron/shared/contract.js";
import type { CliCommand, CliContext, CliResult } from "../lib/context.js";

/** 用法行（与 `collectionCommand.usage` 保持一致）。 */
const USAGE = "collection <list|add|rename|remove|set-category|move> [args]";

/**
 * 对接点：侧栏排序快照即 store.getSidebarOrders 的返回
 * （`category_order` 为分类序，`collection_orders` 为每组合集 id 序，
 * 组 key 为归一化分类名，哨兵 `""` 即未分类）。
 */
export type SidebarOrders = Awaited<ReturnType<typeof getSidebarOrders>>;

/**
 * `add alipan` 分享名查询的可注入依赖。
 *
 * 缺省时 store 走真实网络（`ShareClient`）；测试通过改写
 * `collectionDeps.fetchShareName` 打桩，避免真实网络。
 */
export interface CollectionDeps {
  /** 给定 shareId/pwd 返回分享名。 */
  fetchShareName?: (shareId: string, pwd?: string) => Promise<string>;
  /** 对接点：读侧栏序（缺省走 store.getSidebarOrders）。 */
  getSidebarOrders?: (userDataDir: string) => Promise<SidebarOrders>;
  /** 对接点：按组持久化合集序（缺省走 store.reorderCollections）。 */
  reorderCollections?: (userDataDir: string, category: string, orderedIds: string[]) => Promise<void>;
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

/** 合集归属分组：去两端空白，空即未分类哨兵 `""`。 */
function normalizeGroup(raw?: string | null): string {
  return (raw ?? "").trim();
}

/** 对接点解析：优先用注入依赖，否则用 store 同名导出。 */
function resolveGetSidebarOrders(): (userDataDir: string) => Promise<SidebarOrders> {
  return collectionDeps.getSidebarOrders ?? getSidebarOrders;
}

/** 对接点解析：优先用注入依赖，否则用 store 同名导出。 */
function resolveReorderCollections(): (
  userDataDir: string,
  category: string,
  orderedIds: string[],
) => Promise<void> {
  return collectionDeps.reorderCollections ?? reorderCollections;
}

/**
 * 取该组现序：有存储序则按其过滤并追加本组新增 id，无存储序则按入参回退序。
 */
async function readGroupOrder(
  userDataDir: string,
  group: string,
  fallbackIds: string[],
): Promise<string[]> {
  let stored: string[] | undefined;
  try {
    const orders: SidebarOrders = await resolveGetSidebarOrders()(userDataDir);
    const arr: unknown = orders?.collection_orders?.[group];
    if (Array.isArray(arr) && arr.length > 0) stored = [...(arr as string[])];
  } catch {
    stored = undefined;
  }
  if (stored === undefined || stored.length === 0) return [...fallbackIds];
  const inGroup = new Set<string>(fallbackIds);
  const ordered: string[] = stored.filter((id: string): boolean => inGroup.has(id));
  for (const id of fallbackIds) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

async function runMove(
  ctx: CliContext,
  id: string | undefined,
  toRaw: string | undefined,
  dryRun: boolean,
): Promise<CliResult> {
  if (id === undefined) {
    return usageError("缺少参数：--id <id>");
  }
  if (toRaw === undefined) {
    return usageError("缺少参数：--to <index>");
  }
  const trimmed: string = toRaw.trim();
  const n: number = Number(trimmed);
  if (trimmed === "" || !Number.isInteger(n) || n < 0) {
    return usageError(`--to 须为非负整数（当前：${toRaw}）`);
  }
  try {
    const items: Collection[] = await listCollections(ctx.userDataDir);
    const target: Collection | undefined = items.find((c: Collection): boolean => c.id === id.trim());
    if (target === undefined) {
      return opError("合集不存在", "MOVE_FAILED");
    }
    const group: string = normalizeGroup(target.category);
    const groupIds: string[] = items
      .filter((c: Collection): boolean => normalizeGroup(c.category) === group)
      .map((c: Collection): string => c.id);
    const ordered: string[] = await readGroupOrder(ctx.userDataDir, group, groupIds);
    let cur: number = ordered.indexOf(target.id);
    if (cur === -1) {
      ordered.push(target.id);
      cur = ordered.length - 1;
    }
    const to: number = Math.min(n, ordered.length - 1);
    ordered.splice(cur, 1);
    ordered.splice(to, 0, target.id);
    const label: string = group === "" ? "未分类" : group;
    if (dryRun) {
      return {
        code: 0,
        human: `试运行：合集 ${target.id} 将从 ${cur} 移到 ${to}（分类：${label}）`,
        data: ordered,
      };
    }
    await resolveReorderCollections()(ctx.userDataDir, group, ordered);
    return { code: 0, human: `已移动合集 ${target.id} 到 ${to}（分类：${label}）`, data: ordered };
  } catch (e) {
    return opError(errMsg(e), "MOVE_FAILED");
  }
}

/** 合集列表渲染为 `id kind name` 行（有分类时追加 ` [分类]`）。 */
function renderList(items: Collection[]): string {
  return items
    .map((c: Collection): string => {
      const base = `${c.id} ${c.kind} ${c.name}`;
      const category = c.category?.trim() ?? "";
      return category === "" ? base : `${base} [${category}]`;
    })
    .join("\n");
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
  category: string | undefined,
): Promise<CliResult> {
  if (url === undefined) {
    return usageError("缺少参数：--url <url>");
  }
  try {
    const item: Collection = await addCollection(
      ctx.userDataDir,
      { kind: "alipan", url, pwd, category },
      collectionDeps.fetchShareName === undefined
        ? undefined
        : { fetchShareName: collectionDeps.fetchShareName },
    );
    return { code: 0, human: `已添加合集 ${item.id}（${item.name}）`, data: item };
  } catch (e) {
    return opError(errMsg(e), "ADD_FAILED");
  }
}

async function runAddXhs(
  ctx: CliContext,
  name: string | undefined,
  category: string | undefined,
): Promise<CliResult> {
  if (name === undefined) {
    return usageError("缺少参数：--name <name>");
  }
  try {
    const item: Collection = await addCollection(
      ctx.userDataDir,
      category === undefined ? { kind: "xiaohongshu", name } : { kind: "xiaohongshu", name, category },
    );
    return { code: 0, human: `已添加合集 ${item.id}（${item.name}）`, data: item };
  } catch (e) {
    return opError(errMsg(e), "ADD_FAILED");
  }
}

async function runSetCategory(
  ctx: CliContext,
  id: string | undefined,
  category: string | undefined,
): Promise<CliResult> {
  if (id === undefined) {
    return usageError("缺少参数：--id <id>");
  }
  try {
    const item: Collection = await setCollectionCategory(ctx.userDataDir, id, category);
    const suffix = item.category?.trim() === "" || item.category == null ? "（未分类）" : `（分类：${item.category}）`;
    return { code: 0, human: `已设置合集 ${item.id} ${suffix}`, data: item };
  } catch (e) {
    return opError(errMsg(e), "SET_CATEGORY_FAILED");
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
  let category: string | undefined;
  let toRaw: string | undefined;
  let dryRun = false;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        id: { type: "string" },
        url: { type: "string" },
        pwd: { type: "string" },
        name: { type: "string" },
        category: { type: "string" },
        to: { type: "string" },
        "dry-run": { type: "boolean", default: false },
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
    category = parsed.values.category;
    toRaw = parsed.values.to;
    dryRun = parsed.values["dry-run"] ?? false;
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
        return runAddAlipan(ctx, url, pwd, category);
      }
      if (kind === "xhs") {
        if (positionals.length > 2) {
          const extra: string = positionals[2] as string;
          return usageError(`未知参数：${extra}`);
        }
        return runAddXhs(ctx, name, category);
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
    case "set-category": {
      if (positionals.length > 1) {
        const extra: string = positionals[1] as string;
        return usageError(`未知参数：${extra}`);
      }
      return runSetCategory(ctx, id, category);
    }
    case "move": {
      if (positionals.length > 1) {
        const extra: string = positionals[1] as string;
        return usageError(`未知参数：${extra}`);
      }
      return runMove(ctx, id, toRaw, dryRun);
    }
    default: {
      if (sub === undefined) {
        return usageError("缺少子命令");
      }
      return usageError(`未知子命令：${sub}`);
    }
  }
}

/** `collection` 子命令：`collection <list|add|rename|remove|set-category|move> [args]`。 */
export const collectionCommand: CliCommand = {
  name: "collection",
  describe: "管理合集：查询、新增、重命名、删除、分类与排序",
  usage: USAGE,
  run,
};
