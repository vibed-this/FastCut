/**
 * CLI `category` 子命令：分类的查询与排序。
 *
 * 直接复用 Electron 主进程的 store 层（`electron/main/store.ts`），以
 * `ctx.userDataDir` 作为数据目录。
 */

import { parseArgs } from "node:util";

import {
  getSidebarOrders,
  listCollections,
  reorderCategories,
} from "../../electron/main/store.js";
import type { Collection } from "../../electron/shared/contract.js";
import type { CliCommand, CliContext, CliResult } from "../lib/context.js";

/** 用法行（与 `categoryCommand.usage` 保持一致）。 */
const USAGE = "category <list|move> [args]";

/**
 * 对接点：侧栏排序快照即 store.getSidebarOrders 的返回
 * （`category_order` 为分类序，组 key 为归一化分类名，哨兵 `""` 即未分类）。
 */
export type CategorySidebarOrders = Awaited<ReturnType<typeof getSidebarOrders>>;

/**
 * `category` 的可注入依赖。
 *
 * 缺省时走 store 同名导出；测试通过改写
 * `categoryDeps.getSidebarOrders` / `categoryDeps.reorderCategories` 打桩。
 */
export interface CategoryDeps {
  /** 对接点：读侧栏序（缺省走 store.getSidebarOrders）。 */
  getSidebarOrders?: (userDataDir: string) => Promise<CategorySidebarOrders>;
  /** 对接点：持久化分类序并返回生效序（缺省走 store.reorderCategories）。 */
  reorderCategories?: (userDataDir: string, orderedNames: string[]) => Promise<string[]>;
}

/** 模块级可注入依赖（见 `CategoryDeps`）。 */
export const categoryDeps: CategoryDeps = {};

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

/** 分类归一化：去两端空白，空即未分类哨兵 `""`。 */
function normalizeName(raw?: string | null): string {
  return (raw ?? "").trim();
}

/** 对接点解析：优先用注入依赖，否则用 store 同名导出。 */
function resolveGetSidebarOrders(): (userDataDir: string) => Promise<CategorySidebarOrders> {
  return categoryDeps.getSidebarOrders ?? getSidebarOrders;
}

/** 对接点解析：优先用注入依赖，否则用 store 同名导出。 */
function resolveReorderCategories(): (
  userDataDir: string,
  orderedNames: string[],
) => Promise<string[]> {
  return categoryDeps.reorderCategories ?? reorderCategories;
}

/** 按合集出现顺序派生现存分类（去重，含哨兵 `""` 仅当有未分类合集时）。 */
function deriveExisting(items: Collection[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of items) {
    const name: string = normalizeName(c.category);
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 取分类现序：存储序过滤到现存并追加未知；无存储序时回退为现存出现顺序。
 */
async function readCategoryOrder(userDataDir: string, existing: string[]): Promise<string[]> {
  let stored: string[] | undefined;
  try {
    const orders: CategorySidebarOrders = await resolveGetSidebarOrders()(userDataDir);
    if (Array.isArray(orders?.category_order) && orders.category_order.length > 0) {
      stored = [...orders.category_order].map((n: string): string => normalizeName(n));
    }
  } catch {
    stored = undefined;
  }
  if (stored === undefined || stored.length === 0) return [...existing];
  const alive = new Set<string>(existing);
  const ordered: string[] = stored.filter((n: string): boolean => alive.has(n));
  for (const n of existing) {
    if (!ordered.includes(n)) ordered.push(n);
  }
  return ordered;
}

/** 未分类哨兵的展示名。 */
function displayName(name: string): string {
  return name === "" ? "未分类" : name;
}

async function runList(ctx: CliContext): Promise<CliResult> {
  try {
    const items: Collection[] = await listCollections(ctx.userDataDir);
    const existing: string[] = deriveExisting(items);
    if (existing.length === 0) {
      return { code: 0, human: "暂无分类", data: existing };
    }
    const ordered: string[] = await readCategoryOrder(ctx.userDataDir, existing);
    return { code: 0, human: ordered.map(displayName).join("\n"), data: ordered };
  } catch (e) {
    return opError(errMsg(e), "LIST_FAILED");
  }
}

async function runMove(
  ctx: CliContext,
  nameRaw: string | undefined,
  uncategorized: boolean,
  toRaw: string | undefined,
  dryRun: boolean,
): Promise<CliResult> {
  if (toRaw === undefined) {
    return usageError("缺少参数：--to <index>");
  }
  const trimmed: string = toRaw.trim();
  const n: number = Number(trimmed);
  if (trimmed === "" || !Number.isInteger(n) || n < 0) {
    return usageError(`--to 须为非负整数（当前：${toRaw}）`);
  }
  let target: string | undefined;
  if (uncategorized) {
    target = "";
  } else if (nameRaw === undefined) {
    return usageError("缺少参数：--name <名称>（未分类请用 --uncategorized）");
  } else {
    target = normalizeName(nameRaw);
  }
  try {
    const items: Collection[] = await listCollections(ctx.userDataDir);
    const existing: string[] = deriveExisting(items);
    const ordered: string[] = await readCategoryOrder(ctx.userDataDir, existing);
    const cur: number = ordered.indexOf(target);
    if (cur === -1) {
      return opError(`未知分类：${displayName(target)}`, "MOVE_FAILED");
    }
    const to: number = Math.min(n, ordered.length - 1);
    ordered.splice(cur, 1);
    ordered.splice(to, 0, target);
    if (dryRun) {
      return {
        code: 0,
        human: `试运行：分类 ${displayName(target)} 将从 ${cur} 移到 ${to}`,
        data: ordered,
      };
    }
    const effective: string[] = await resolveReorderCategories()(ctx.userDataDir, ordered);
    return { code: 0, human: `已移动分类 ${displayName(target)} 到 ${to}`, data: effective };
  } catch (e) {
    return opError(errMsg(e), "MOVE_FAILED");
  }
}

async function run(ctx: CliContext, argv: string[]): Promise<CliResult> {
  let positionals: string[];
  let name: string | undefined;
  let toRaw: string | undefined;
  let uncategorized = false;
  let dryRun = false;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        name: { type: "string" },
        to: { type: "string" },
        uncategorized: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
    positionals = parsed.positionals;
    if (parsed.values.help === true) {
      return { code: 0, human: `用法：${USAGE}` };
    }
    name = parsed.values.name;
    toRaw = parsed.values.to;
    uncategorized = parsed.values.uncategorized ?? false;
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
    case "move": {
      if (positionals.length > 1) {
        const extra: string = positionals[1] as string;
        return usageError(`未知参数：${extra}`);
      }
      return runMove(ctx, name, uncategorized, toRaw, dryRun);
    }
    default: {
      if (sub === undefined) {
        return usageError("缺少子命令");
      }
      return usageError(`未知子命令：${sub}`);
    }
  }
}

/** `category` 子命令：`category <list|move> [args]`。 */
export const categoryCommand: CliCommand = {
  name: "category",
  describe: "管理分类：查询与排序",
  usage: USAGE,
  run,
};
