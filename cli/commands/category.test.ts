/**
 * `cli/commands/category.ts` 的 vitest 测试。
 *
 * 覆盖：list 空/非空渲染（含未分类行）、存储序缺失未知分类追加、
 * move 换序持久化、未知名失败 code 2、to 非法 code 1、dry-run 不落盘。
 * 合集经 `collectionCommand`（`collectionDeps.fetchShareName` 打桩）建，
 * HOME 指向空目录，避免读到本机旧数据。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSidebarOrders } from "../../electron/main/store.js";
import type { CliContext, CliResult } from "../lib/context.js";
import { categoryCommand, categoryDeps } from "./category.js";
import { collectionCommand, collectionDeps } from "./collection.js";

let dir = "";
let emptyHome = "";
let savedHome: string | undefined;

function ctx(): CliContext {
  return { userDataDir: dir, json: false, verbose: false };
}

/** 打桩分享名查询：返回 `分享-<shareId>`。 */
function stubShareName(): (shareId: string) => Promise<string> {
  return async (shareId: string): Promise<string> => `分享-${shareId}`;
}

async function addAlipan(id: string, category?: string): Promise<void> {
  collectionDeps.fetchShareName = stubShareName();
  const argv: string[] = ["add", "alipan", "--url", `https://www.alipan.com/s/${id}`];
  if (category !== undefined) argv.push("--category", category);
  const res: CliResult = await collectionCommand.run(ctx(), argv);
  expect(res.code).toBe(0);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastcut-cli-category-"));
  emptyHome = await mkdtemp(join(tmpdir(), "fastcut-cli-category-home-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = emptyHome;
  collectionDeps.fetchShareName = undefined;
  collectionDeps.getSidebarOrders = undefined;
  collectionDeps.reorderCollections = undefined;
  categoryDeps.getSidebarOrders = undefined;
  categoryDeps.reorderCategories = undefined;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  collectionDeps.fetchShareName = undefined;
  collectionDeps.getSidebarOrders = undefined;
  collectionDeps.reorderCollections = undefined;
  categoryDeps.getSidebarOrders = undefined;
  categoryDeps.reorderCategories = undefined;
  await rm(dir, { recursive: true, force: true });
  await rm(emptyHome, { recursive: true, force: true });
});

describe("category list", () => {
  it("空合集时 human 为暂无分类，code 仍为 0", async () => {
    const res: CliResult = await categoryCommand.run(ctx(), ["list"]);
    expect(res.code).toBe(0);
    expect(res.human).toBe("暂无分类");
    expect(res.data).toEqual([]);
  });

  it("按存储序输出每行分类名，未分类显示未分类", async () => {
    await addAlipan("c1", "学习");
    await addAlipan("c2", "素材");
    await addAlipan("c3");

    const res: CliResult = await categoryCommand.run(ctx(), ["list"]);
    expect(res.code).toBe(0);
    expect(res.human).toBe("学习\n素材\n未分类");
    expect(res.data).toEqual(["学习", "素材", ""]);
  });

  it("存储序缺失的现存分类追加到尾部", async () => {
    await addAlipan("c1", "学习");
    await addAlipan("c2", "素材");
    categoryDeps.getSidebarOrders = async () => ({ category_order: ["素材"], collection_orders: {} });
    const res: CliResult = await categoryCommand.run(ctx(), ["list"]);
    expect(res.code).toBe(0);
    expect(res.human).toBe("素材\n学习");
    expect(res.data).toEqual(["素材", "学习"]);
  });
});

describe("category move", () => {
  it("换序后持久化并返回生效序", async () => {
    await addAlipan("c1", "A");
    await addAlipan("c2", "B");
    await addAlipan("c3", "C");

    const res: CliResult = await categoryCommand.run(ctx(), ["move", "--name", "B", "--to", "0"]);
    expect(res.code).toBe(0);
    expect(res.data).toEqual(["B", "A", "C"]);
    await expect(getSidebarOrders(dir)).resolves.toMatchObject({
      category_order: ["B", "A", "C"],
    });
  });

  it("越界下标 clamp 到尾部", async () => {
    await addAlipan("c1", "A");
    await addAlipan("c2", "B");

    const res: CliResult = await categoryCommand.run(ctx(), ["move", "--name", "A", "--to", "99"]);
    expect(res.code).toBe(0);
    expect(res.data).toEqual(["B", "A"]);
  });

  it("未分类哨兵经 --uncategorized 与空 --name 移动", async () => {
    await addAlipan("c1", "A");
    await addAlipan("c2");

    const first: CliResult = await categoryCommand.run(ctx(), [
      "move",
      "--uncategorized",
      "--to",
      "0",
    ]);
    expect(first.code).toBe(0);
    expect(first.data).toEqual(["", "A"]);

    const second: CliResult = await categoryCommand.run(ctx(), [
      "move",
      "--name",
      "",
      "--to",
      "1",
    ]);
    expect(second.code).toBe(0);
    expect(second.data).toEqual(["A", ""]);
  });

  it("未知分类名返回 code 2", async () => {
    await addAlipan("c1", "A");
    const res: CliResult = await categoryCommand.run(ctx(), ["move", "--name", "不存在", "--to", "0"]);
    expect(res.code).toBe(2);
    expect(res.errorCode).toBe("MOVE_FAILED");
    expect(res.error).toContain("未知分类");
  });

  it("参数缺失与 to 非法返回 code 1", async () => {
    await addAlipan("c1", "A");
    const cases: string[][] = [
      [],
      ["bogus"],
      ["move"],
      ["move", "--name", "A"],
      ["move", "--to", "0"],
      ["move", "--name", "A", "--to", "abc"],
      ["move", "--name", "A", "--to", "-1"],
      ["move", "--name", "A", "--to", "1.5"],
    ];
    for (const argv of cases) {
      const res: CliResult = await categoryCommand.run(ctx(), argv);
      expect(res.code).toBe(1);
      expect(res.errorCode).toBe("USAGE");
    }
  });

  it("dry-run 不调用写函数且不落盘", async () => {
    await addAlipan("c1", "A");
    await addAlipan("c2", "B");
    let calls = 0;
    categoryDeps.reorderCategories = async (): Promise<string[]> => {
      calls += 1;
      return [];
    };
    try {
      const res: CliResult = await categoryCommand.run(ctx(), [
        "move",
        "--name",
        "B",
        "--to",
        "0",
        "--dry-run",
      ]);
      expect(res.code).toBe(0);
      expect(res.data).toEqual(["B", "A"]);
      expect(calls).toBe(0);
      await expect(getSidebarOrders(dir)).resolves.toMatchObject({ category_order: ["A", "B"] });
    } finally {
      categoryDeps.reorderCategories = undefined;
    }
  });
});
