/**
 * `cli/commands/import-xhs.ts` 的 vitest 测试。
 *
 * 覆盖：缺 url 返回 1、dry-run 调 parse stub（mock `XhsClient`，不打真实网络）、
 * relDir 拼接规则（断言 `downloadXhsDirect` 收到的 relDir）、重入返回码。
 * store/target 走真实模块，`userDataDir` 与目标目录用 `mkdtemp` 临时目录隔离，
 * HOME 指向空目录避免读到本机旧数据；解析与下载经 `vi.mock` 打桩。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DownloadXhsDirectOptions } from "../../electron/main/downloader.js";
import { xhsInFlightKey } from "../../electron/main/downloader.js";
import { addCollection, listCollections, setConfig } from "../../electron/main/store.js";
import type { XhsParseResult } from "../../electron/main/xhs-client.js";
import type { Collection } from "../../electron/shared/contract.js";
import type { DownloadEmit } from "../lib/await-download.js";
import type { CliContext, CliResult } from "../lib/context.js";
import { runXhs } from "./import-xhs.js";

/** 打桩夹具的形状（经 `vi.hoisted` 先行初始化，供 `vi.mock` 工厂引用）。 */
interface XhsFixtures {
  parseCalls: string[];
  parseImpl: (url: string) => Promise<XhsParseResult>;
  downloadCalls: Array<{ collectionId: string; relDir: string; fileName: string; title: string }>;
  downloadImpl: (opts: DownloadXhsDirectOptions) => Promise<string>;
  waitCalls: string[];
  waitImpl: (matchFileId: string) => Promise<string>;
}

const fixtures: XhsFixtures = vi.hoisted(() => ({
  parseCalls: [],
  parseImpl: (_url: string): Promise<XhsParseResult> =>
    Promise.resolve({ title: "", downloadUrl: "", cover: "", noteId: "", author: "" }),
  downloadCalls: [],
  downloadImpl: (_opts: DownloadXhsDirectOptions): Promise<string> => Promise.resolve("started"),
  waitCalls: [],
  waitImpl: (matchFileId: string): Promise<string> => Promise.resolve(`/tmp/${matchFileId}.mp4`),
}));

vi.mock("../../electron/main/xhs-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../electron/main/xhs-client.js")>();
  class StubXhsClient {
    parse(url: string): Promise<XhsParseResult> {
      fixtures.parseCalls.push(url);
      return fixtures.parseImpl(url);
    }
  }
  return { ...actual, XhsClient: StubXhsClient };
});

vi.mock("../../electron/main/downloader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../electron/main/downloader.js")>();
  return {
    ...actual,
    downloadXhsDirect: async (opts: DownloadXhsDirectOptions): Promise<string> => {
      fixtures.downloadCalls.push({
        collectionId: opts.collectionId,
        relDir: opts.relDir ?? "",
        fileName: opts.fileName ?? "",
        title: opts.title ?? "",
      });
      return fixtures.downloadImpl(opts);
    },
  };
});

vi.mock("../lib/await-download.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/await-download.js")>();
  return {
    ...actual,
    waitForDone: async (
      start: (emit: DownloadEmit<unknown>) => Promise<string>,
      matchFileId: string,
    ): Promise<string> => {
      await start(() => undefined);
      fixtures.waitCalls.push(matchFileId);
      return fixtures.waitImpl(matchFileId);
    },
  };
});

let dir = "";
let target = "";
let emptyHome = "";
let savedHome: string | undefined;

const XHS_URL = "https://www.xiaohongshu.com/explore/abc123";

const PARSE_FIXTURE: XhsParseResult = {
  title: "我的视频",
  downloadUrl: "https://cdn.example.com/v.mp4",
  cover: "https://cdn.example.com/c.jpg",
  noteId: "abc123",
  author: "作者",
};

function ctx(): CliContext {
  return { userDataDir: dir, json: false, verbose: false };
}

/** 建一个 xhs 合集（真实 store，relDir 落盘到临时目标目录）。 */
async function addXhs(name: string): Promise<Collection> {
  return addCollection(dir, { kind: "xiaohongshu", name });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastcut-cli-xhs-"));
  target = await mkdtemp(join(tmpdir(), "fastcut-cli-xhs-target-"));
  emptyHome = await mkdtemp(join(tmpdir(), "fastcut-cli-xhs-home-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = emptyHome;
  await setConfig(dir, { target_dir: target });
  fixtures.parseCalls = [];
  fixtures.parseImpl = (_url: string): Promise<XhsParseResult> =>
    Promise.resolve({ ...PARSE_FIXTURE });
  fixtures.downloadCalls = [];
  fixtures.downloadImpl = (_opts: DownloadXhsDirectOptions): Promise<string> =>
    Promise.resolve("started");
  fixtures.waitCalls = [];
  fixtures.waitImpl = (matchFileId: string): Promise<string> =>
    Promise.resolve(join(target, `${matchFileId.replace(/[/\\:]/g, "_")}.mp4`));
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  await rm(dir, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
  await rm(emptyHome, { recursive: true, force: true });
});

describe("import xhs 参数校验", () => {
  it("缺 url 返回 1", async () => {
    const r1: CliResult = await runXhs(ctx(), []);
    expect(r1.code).toBe(1);
    expect(r1.errorCode).toBe("USAGE");
    const r2: CliResult = await runXhs(ctx(), ["--dry-run"]);
    expect(r2.code).toBe(1);
    expect(r2.errorCode).toBe("USAGE");
    expect(fixtures.parseCalls).toHaveLength(0);
  });

  it("非小红书链接返回 1 且不调 parse", async () => {
    const res: CliResult = await runXhs(ctx(), ["https://www.alipan.com/s/abc", "--dry-run"]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
    expect(fixtures.parseCalls).toHaveLength(0);
  });

  it("--timeout 非法值与未知 flag 返回 1", async () => {
    const r1: CliResult = await runXhs(ctx(), [XHS_URL, "--timeout", "0"]);
    expect(r1.code).toBe(1);
    expect(r1.errorCode).toBe("USAGE");
    const r2: CliResult = await runXhs(ctx(), [XHS_URL, "--bogus"]);
    expect(r2.code).toBe(1);
    expect(r2.errorCode).toBe("USAGE");
    expect(fixtures.parseCalls).toHaveLength(0);
  });

  it("无合集时返回 1", async () => {
    const res: CliResult = await runXhs(ctx(), [XHS_URL, "--dry-run"]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
    expect(res.human).toContain("暂无小红书合集");
  });

  it("多合集缺 --collection 时提示候选返回 1", async () => {
    await addXhs("合集A");
    await addXhs("合集B");
    const res: CliResult = await runXhs(ctx(), [XHS_URL, "--dry-run"]);
    expect(res.code).toBe(1);
    expect(res.human).toContain("--collection");
  });

  it("--collection 未命中返回 1", async () => {
    await addXhs("合集A");
    const res: CliResult = await runXhs(ctx(), [XHS_URL, "--dry-run", "--collection", "不存在"]);
    expect(res.code).toBe(1);
    expect(res.human).toContain("合集不存在");
  });
});

describe("import xhs dry-run", () => {
  it("只调 parse：human 回显四字段，data 原样，不下载", async () => {
    const coll: Collection = await addXhs("我的合集");
    expect(coll.id.startsWith("xhs_")).toBe(true);
    const res: CliResult = await runXhs(ctx(), [XHS_URL, "--dry-run"]);
    expect(res.code).toBe(0);
    expect(fixtures.parseCalls).toEqual([XHS_URL]);
    expect(res.human).toContain("我的视频");
    expect(res.human).toContain("作者");
    expect(res.human).toContain("https://cdn.example.com/c.jpg");
    expect(res.human).toContain("abc123");
    expect(res.data).toEqual(PARSE_FIXTURE);
    expect(fixtures.downloadCalls).toHaveLength(0);
    expect(fixtures.waitCalls).toHaveLength(0);
  });
});

describe("import xhs relDir 拼接", () => {
  it("缺省用合集根；纯 sub 拼接；已含前缀直接用", async () => {
    const coll: Collection = await addXhs("我的合集");
    const stored: Collection | undefined = (await listCollections(dir)).find(
      (c: Collection): boolean => c.id === coll.id,
    );
    const base: string = stored?.relDir ?? "";
    expect(base).not.toBe("");

    const r1: CliResult = await runXhs(ctx(), [XHS_URL]);
    expect(r1.code).toBe(0);
    expect(fixtures.downloadCalls[0]?.relDir).toBe(base);

    const r2: CliResult = await runXhs(ctx(), [XHS_URL, "--subdir", "ep1"]);
    expect(r2.code).toBe(0);
    expect(fixtures.downloadCalls[1]?.relDir).toBe(`${base}/ep1`);

    const r3: CliResult = await runXhs(ctx(), [XHS_URL, "--subdir", `${base}/ep1`]);
    expect(r3.code).toBe(0);
    expect(fixtures.downloadCalls[2]?.relDir).toBe(`${base}/ep1`);
  });

  it("--collection 按 id 与 name 精确匹配", async () => {
    const a: Collection = await addXhs("合集A");
    const b: Collection = await addXhs("合集B");
    const rByName: CliResult = await runXhs(ctx(), [XHS_URL, "--collection", "合集B"]);
    expect(rByName.code).toBe(0);
    expect(fixtures.downloadCalls[0]?.collectionId).toBe(b.id);
    const rById: CliResult = await runXhs(ctx(), [XHS_URL, "--collection", a.id]);
    expect(rById.code).toBe(0);
    expect(fixtures.downloadCalls[1]?.collectionId).toBe(a.id);
  });

  it("成功 human 含路径与 sidecar，data 含四字段", async () => {
    const coll: Collection = await addXhs("我的合集");
    const res: CliResult = await runXhs(ctx(), [XHS_URL]);
    expect(res.code).toBe(0);
    expect(res.human).toContain("✓ 已导入");
    expect(res.human).toContain("sidecar");
    expect(fixtures.waitCalls[0]).toBe(xhsInFlightKey(coll.id, "我的视频"));
    const data = res.data as { path: string; sidecar: string; title: string; noteId: string };
    expect(data.title).toBe("我的视频");
    expect(data.noteId).toBe("abc123");
    expect(data.path.endsWith(".mp4")).toBe(true);
    expect(data.sidecar).toBe(`${data.path.replace(/\.mp4$/i, "")}.meta.json`);
  });

  it("防重入 key 用清洗后的 stem", async () => {
    const coll: Collection = await addXhs("我的合集");
    fixtures.parseImpl = (_url: string): Promise<XhsParseResult> =>
      Promise.resolve({ ...PARSE_FIXTURE, title: "a/b:c" });
    const res: CliResult = await runXhs(ctx(), [XHS_URL]);
    expect(res.code).toBe(0);
    expect(fixtures.waitCalls).toHaveLength(1);
    expect(fixtures.waitCalls[0]).toBe(xhsInFlightKey(coll.id, "abc"));
  });
});

describe("import xhs 重入", () => {
  it("downloadXhsDirect 返回 downloading 时短路成功且不再等待", async () => {
    await addXhs("我的合集");
    fixtures.downloadImpl = (_opts: DownloadXhsDirectOptions): Promise<string> =>
      Promise.resolve("downloading");
    const res: CliResult = await runXhs(ctx(), [XHS_URL]);
    expect(res.code).toBe(0);
    expect(res.human).toContain("已在下载中");
    expect(fixtures.waitCalls).toHaveLength(0);
    const data = res.data as { downloading: boolean; title: string };
    expect(data.downloading).toBe(true);
    expect(data.title).toBe("我的视频");
  });
});
