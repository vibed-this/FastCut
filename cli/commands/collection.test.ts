/**
 * `cli/commands/collection.ts` 的 vitest 测试。
 *
 * 覆盖：list 空/非空 human 渲染、add/rename/remove 参数缺失返回 code 1、
 * 增删改走临时目录 `userDataDir`（`mkdtemp` 隔离）、alipan 网络查询经
 * `collectionDeps.fetchShareName` 打桩。HOME 指向空目录，避免读到本机旧数据。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addCollection,
  getSidebarOrders,
  listCollections,
  setConfig,
} from "../../electron/main/store.js";
import type { Collection } from "../../electron/shared/contract.js";
import type { CliContext, CliResult } from "../lib/context.js";
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastcut-cli-collection-"));
  emptyHome = await mkdtemp(join(tmpdir(), "fastcut-cli-collection-home-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = emptyHome;
  collectionDeps.fetchShareName = undefined;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  collectionDeps.fetchShareName = undefined;
  await rm(dir, { recursive: true, force: true });
  await rm(emptyHome, { recursive: true, force: true });
});

describe("collection list", () => {
  it("空合集时 human 为暂无合集，code 仍为 0", async () => {
    const res: CliResult = await collectionCommand.run(ctx(), ["list"]);
    expect(res.code).toBe(0);
    expect(res.human).toBe("暂无合集");
    expect(res.data).toEqual([]);
  });

  it("非空时 human 按行输出 id kind name", async () => {
    const fetchShareName = stubShareName();
    await addCollection(dir, { kind: "alipan", url: "https://www.alipan.com/s/s1" }, { fetchShareName });
    await addCollection(dir, { kind: "alipan", url: "https://www.alipan.com/s/s2" }, { fetchShareName });

    const res: CliResult = await collectionCommand.run(ctx(), ["list"]);
    expect(res.code).toBe(0);
    expect(res.human).toBe("s1 alipan 分享-s1\ns2 alipan 分享-s2");
    const items = res.data as Collection[];
    expect(items).toHaveLength(2);
    expect(items.map((c: Collection): string => c.id)).toEqual(["s1", "s2"]);
  });
});

describe("collection 参数缺失与未知子命令", () => {
  it("返回 code 1 且 errorCode 为 USAGE", async () => {
    const cases: string[][] = [
      [],
      ["bogus"],
      ["add"],
      ["add", "bogus"],
      ["add", "alipan"],
      ["add", "xhs"],
      ["rename", "--id", "s1"],
      ["rename", "--name", "新名"],
      ["rename"],
      ["remove"],
    ];
    for (const argv of cases) {
      const res: CliResult = await collectionCommand.run(ctx(), argv);
      expect(res.code).toBe(1);
      expect(res.errorCode).toBe("USAGE");
    }
  });
});

describe("collection add alipan", () => {
  it("经 fetchShareName 打桩落盘，走临时 userDataDir", async () => {
    collectionDeps.fetchShareName = stubShareName();
    const res: CliResult = await collectionCommand.run(ctx(), [
      "add",
      "alipan",
      "--url",
      "https://www.alipan.com/s/cli123",
      "--pwd",
      "pw",
    ]);
    expect(res.code).toBe(0);
    const item = res.data as Collection;
    expect(item.id).toBe("cli123");
    expect(item.kind).toBe("alipan");
    expect(item.name).toBe("分享-cli123");
    expect(item.pwd).toBe("pw");
    await expect(listCollections(dir)).resolves.toEqual([item]);
  });

  it("网络查询失败时返回 code 2 且 errorCode 为 ADD_FAILED", async () => {
    collectionDeps.fetchShareName = async (): Promise<string> => {
      throw new Error("网络开小差");
    };
    const res: CliResult = await collectionCommand.run(ctx(), [
      "add",
      "alipan",
      "--url",
      "https://www.alipan.com/s/netfail",
    ]);
    expect(res.code).toBe(2);
    expect(res.errorCode).toBe("ADD_FAILED");
    expect(res.error).toBe("网络开小差");
    await expect(listCollections(dir)).resolves.toEqual([]);
  });
});

describe("collection add xhs", () => {
  it("缺 target_dir 时错误透传，code 为 2", async () => {
    const res: CliResult = await collectionCommand.run(ctx(), ["add", "xhs", "--name", "旅行"]);
    expect(res.code).toBe(2);
    expect(res.errorCode).toBe("ADD_FAILED");
    expect(res.error).toContain("未配置目标文件夹");
  });

  it("有 target_dir 时落盘并返回合集", async () => {
    const target: string = await mkdtemp(join(tmpdir(), "fastcut-cli-target-"));
    try {
      await setConfig(dir, { target_dir: target });
      const res: CliResult = await collectionCommand.run(ctx(), ["add", "xhs", "--name", "旅行"]);
      expect(res.code).toBe(0);
      const item = res.data as Collection;
      expect(item.kind).toBe("xiaohongshu");
      expect(item.name).toBe("旅行");
      expect(item.id.startsWith("xhs_")).toBe(true);
      await expect(listCollections(dir)).resolves.toEqual([item]);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

describe("collection rename/remove", () => {
  it("重命名与删除往返，删除不存在的返回 code 2", async () => {
    collectionDeps.fetchShareName = stubShareName();
    const added: CliResult = await collectionCommand.run(ctx(), [
      "add",
      "alipan",
      "--url",
      "https://www.alipan.com/s/rw1",
    ]);
    expect(added.code).toBe(0);

    const renamed: CliResult = await collectionCommand.run(ctx(), [
      "rename",
      "--id",
      "rw1",
      "--name",
      "新名",
    ]);
    expect(renamed.code).toBe(0);
    expect((renamed.data as Collection).name).toBe("新名");

    const missing: CliResult = await collectionCommand.run(ctx(), [
      "rename",
      "--id",
      "nope",
      "--name",
      "x",
    ]);
    expect(missing.code).toBe(2);
    expect(missing.error).toBe("合集不存在");

    const removed: CliResult = await collectionCommand.run(ctx(), ["remove", "--id", "rw1"]);
    expect(removed.code).toBe(0);
    await expect(listCollections(dir)).resolves.toEqual([]);

    const again: CliResult = await collectionCommand.run(ctx(), ["remove", "--id", "rw1"]);
    expect(again.code).toBe(2);
    expect(again.error).toBe("合集不存在");
  });

  it("set-category 设置与清空分类", async () => {
    collectionDeps.fetchShareName = stubShareName();
    const added: CliResult = await collectionCommand.run(ctx(), [
      "add",
      "alipan",
      "--url",
      "https://www.alipan.com/s/catcli",
      "--category",
      "学习",
    ]);
    expect(added.code).toBe(0);
    expect((added.data as Collection).category).toBe("学习");

    const listed: CliResult = await collectionCommand.run(ctx(), ["list"]);
    expect(listed.code).toBe(0);
    expect(listed.human).toContain("[学习]");

    const updated: CliResult = await collectionCommand.run(ctx(), [
      "set-category",
      "--id",
      "catcli",
      "--category",
      "素材",
    ]);
    expect(updated.code).toBe(0);
    expect((updated.data as Collection).category).toBe("素材");

    const cleared: CliResult = await collectionCommand.run(ctx(), [
      "set-category",
      "--id",
      "catcli",
    ]);
    expect(cleared.code).toBe(0);
    expect((cleared.data as Collection).category).toBeUndefined();

    const missing: CliResult = await collectionCommand.run(ctx(), [
      "set-category",
      "--id",
      "nope",
      "--category",
      "x",
    ]);
    expect(missing.code).toBe(2);
    expect(missing.error).toBe("合集不存在");
  });

  it("删除 alipan 合集后清掉其缩略图缓存", async () => {
    collectionDeps.fetchShareName = stubShareName();
    const added: CliResult = await collectionCommand.run(ctx(), [
      "add",
      "alipan",
      "--url",
      "https://www.alipan.com/s/thumb1",
    ]);
    expect(added.code).toBe(0);

    const cached: string = join(dir, "thumbnails", "thumb1", "f1.jpg");
    await mkdir(join(dir, "thumbnails", "thumb1"), { recursive: true });
    await writeFile(cached, "fake-jpg");

    const removed: CliResult = await collectionCommand.run(ctx(), ["remove", "--id", "thumb1"]);
    expect(removed.code).toBe(0);
    await expect(readFile(cached)).rejects.toThrow();
  });
});

describe("collection move", () => {
  async function addAlipan(id: string, category?: string): Promise<void> {
    collectionDeps.fetchShareName = stubShareName();
    const argv: string[] = ["add", "alipan", "--url", `https://www.alipan.com/s/${id}`];
    if (category !== undefined) argv.push("--category", category);
    const res: CliResult = await collectionCommand.run(ctx(), argv);
    expect(res.code).toBe(0);
  }

  it("组内正常移动并持久化侧栏序", async () => {
    await addAlipan("m1", "A");
    await addAlipan("m2", "A");
    await addAlipan("m3", "A");

    const res: CliResult = await collectionCommand.run(ctx(), ["move", "--id", "m1", "--to", "2"]);
    expect(res.code).toBe(0);
    expect(res.data).toEqual(["m2", "m3", "m1"]);
    expect(res.human).toContain("m1");
    await expect(getSidebarOrders(dir)).resolves.toMatchObject({
      collection_orders: { A: ["m2", "m3", "m1"] },
    });
  });

  it("越界下标 clamp 到尾部", async () => {
    await addAlipan("m1", "A");
    await addAlipan("m2", "A");
    await addAlipan("m3", "A");

    const res: CliResult = await collectionCommand.run(ctx(), ["move", "--id", "m1", "--to", "99"]);
    expect(res.code).toBe(0);
    expect(res.data).toEqual(["m2", "m3", "m1"]);
  });

  it("无存储序时回退按现存出现顺序", async () => {
    await addAlipan("m1", "A");
    await addAlipan("m2", "A");
    collectionDeps.getSidebarOrders = async () => ({ category_order: [], collection_orders: {} });
    try {
      const res: CliResult = await collectionCommand.run(ctx(), [
        "move",
        "--id",
        "m2",
        "--to",
        "0",
      ]);
      expect(res.code).toBe(0);
      expect(res.data).toEqual(["m2", "m1"]);
    } finally {
      collectionDeps.getSidebarOrders = undefined;
    }
  });

  it("to 非法与 id 缺失返回 code 1", async () => {
    await addAlipan("m1", "A");
    const cases: string[][] = [
      ["move"],
      ["move", "--id", "m1"],
      ["move", "--to", "0"],
      ["move", "--id", "m1", "--to", "abc"],
      ["move", "--id", "m1", "--to", "-1"],
      ["move", "--id", "m1", "--to", "1.5"],
    ];
    for (const argv of cases) {
      const res: CliResult = await collectionCommand.run(ctx(), argv);
      expect(res.code).toBe(1);
      expect(res.errorCode).toBe("USAGE");
    }
  });

  it("未知 id 返回 code 2 且透传合集不存在", async () => {
    const res: CliResult = await collectionCommand.run(ctx(), ["move", "--id", "nope", "--to", "0"]);
    expect(res.code).toBe(2);
    expect(res.errorCode).toBe("MOVE_FAILED");
    expect(res.error).toBe("合集不存在");
  });

  it("只在组内移动，不影响他组现序", async () => {
    await addAlipan("a1", "A");
    await addAlipan("a2", "A");
    await addAlipan("b1", "B");
    await addAlipan("b2", "B");

    const res: CliResult = await collectionCommand.run(ctx(), ["move", "--id", "a1", "--to", "1"]);
    expect(res.code).toBe(0);
    expect(res.data).toEqual(["a2", "a1"]);
    await expect(getSidebarOrders(dir)).resolves.toMatchObject({
      collection_orders: { A: ["a2", "a1"], B: ["b1", "b2"] },
    });
  });

  it("dry-run 不调用写函数且不落盘", async () => {
    await addAlipan("m1", "A");
    await addAlipan("m2", "A");
    let calls = 0;
    collectionDeps.reorderCollections = async (): Promise<void> => {
      calls += 1;
    };
    try {
      const res: CliResult = await collectionCommand.run(ctx(), [
        "move",
        "--id",
        "m1",
        "--to",
        "1",
        "--dry-run",
      ]);
      expect(res.code).toBe(0);
      expect(res.data).toEqual(["m2", "m1"]);
      expect(calls).toBe(0);
      await expect(getSidebarOrders(dir)).resolves.toMatchObject({
        collection_orders: { A: ["m1", "m2"] },
      });
    } finally {
      collectionDeps.reorderCollections = undefined;
    }
  });
});
