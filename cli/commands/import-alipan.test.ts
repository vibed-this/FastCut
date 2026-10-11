/**
 * `cli/commands/import-alipan.ts` 的 vitest 测试。
 *
 * 覆盖：缺定位参数返回 1、`--path` 逐段定位逻辑（打桩 share-api `list_share`）、
 * definition 非法值返回 1、批量汇总模型（部分失败 code 仍 0，全部失败 code 2）。
 * 经 `vi.mock` 打桩网络与下载（`list_share` / `pick_preview_url` /
 * `downloadVideo` / `waitForDone`），不打真实网络；`userDataDir` 与目标目录走
 * `mkdtemp` 临时目录隔离，HOME 指向空目录避免读到本机旧数据。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DownloadVideoOptions } from "../../electron/main/downloader.js";
import { recordLedger, setConfig } from "../../electron/main/store.js";
import type {
  ListShareResult,
  PickPreviewResult,
  ShareItem,
} from "../../electron/shared/contract.js";
import type { DownloadEmit } from "../lib/await-download.js";
import type { CliContext, CliResult } from "../lib/context.js";
import { runAlipan } from "./import-alipan.js";

/** 打桩夹具的形状（经 `vi.hoisted` 先行初始化，供 `vi.mock` 工厂引用）。 */
interface AlipanFixtures {
  pages: Record<string, ShareItem[]>;
  listCalls: Array<{ shareId: string; parent: string }>;
  pickCalls: Array<{ shareId: string; driveId: string; fileId: string; definition: string }>;
  pickResult: PickPreviewResult;
  downloadCalls: Array<{
    m3u8Url: string;
    shareId: string;
    fileId: string;
    fileName: string;
    template: string;
    subDir: string;
  }>;
  waitImpl: (fileId: string) => Promise<string>;
}

const fixtures: AlipanFixtures = vi.hoisted(() => ({
  pages: {},
  listCalls: [],
  pickCalls: [],
  pickResult: { url: "https://cdn.example/v.m3u8", template: "HD" },
  downloadCalls: [],
  waitImpl: (_fileId: string): Promise<string> => Promise.resolve("/tmp/fake.mp4"),
}));

vi.mock("../../electron/main/share-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../electron/main/share-api.js")>();
  return {
    ...actual,
    list_share: async (shareId: string, parentFileId: string): Promise<ListShareResult> => {
      fixtures.listCalls.push({ shareId, parent: parentFileId });
      return { items: fixtures.pages[parentFileId] ?? [], next_marker: "" };
    },
    pick_preview_url: async (
      shareId: string,
      driveId: string,
      fileId: string,
      definition: string,
      _pwd?: string,
    ): Promise<PickPreviewResult> => {
      fixtures.pickCalls.push({ shareId, driveId, fileId, definition });
      return fixtures.pickResult;
    },
  };
});

vi.mock("../../electron/main/downloader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../electron/main/downloader.js")>();
  return {
    ...actual,
    downloadVideo: async (opts: DownloadVideoOptions): Promise<string> => {
      fixtures.downloadCalls.push({
        m3u8Url: opts.m3u8Url,
        shareId: opts.shareId,
        fileId: opts.fileId,
        fileName: opts.fileName,
        template: opts.template,
        subDir: opts.subDir,
      });
      return "started";
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
      return fixtures.waitImpl(matchFileId);
    },
  };
});

let dir = "";
let target = "";
let emptyHome = "";
let savedHome: string | undefined;

const SHARE_URL = "https://www.alipan.com/s/s1";

function ctx(): CliContext {
  return { userDataDir: dir, json: false, verbose: false };
}

/** 视频文件条目（`category=video`，与 UI 判定一致）。 */
function videoFile(file_id: string, name: string): ShareItem {
  return { file_id, drive_id: "d1", name, type: "file", category: "video", file_extension: "mp4" };
}

/** 目录条目。 */
function folder(file_id: string, name: string): ShareItem {
  return { file_id, drive_id: "d1", name, type: "folder" };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastcut-cli-alipan-"));
  target = await mkdtemp(join(tmpdir(), "fastcut-cli-alipan-target-"));
  emptyHome = await mkdtemp(join(tmpdir(), "fastcut-cli-alipan-home-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = emptyHome;
  await setConfig(dir, { target_dir: target });
  fixtures.pages = {};
  fixtures.listCalls = [];
  fixtures.pickCalls = [];
  fixtures.pickResult = { url: "https://cdn.example/v.m3u8", template: "HD" };
  fixtures.downloadCalls = [];
  fixtures.waitImpl = (_fileId: string): Promise<string> => Promise.resolve("/tmp/fake.mp4");
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  await rm(dir, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
  await rm(emptyHome, { recursive: true, force: true });
});

describe("import alipan 参数校验", () => {
  it("缺定位参数返回 1", async () => {
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
  });

  it("--file-id 与 --all 同用返回 1", async () => {
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--file-id", "f1", "--all"]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
  });

  it("definition 非法值返回 1", async () => {
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--file-id", "f1", "--definition", "4K"]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
    expect(fixtures.listCalls).toHaveLength(0);
  });

  it("未知 flag 返回 1", async () => {
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--bogus"]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
  });

  it("非 alipan 链接返回 1", async () => {
    const res: CliResult = await runAlipan(ctx(), [
      "https://example.com/s/x",
      "--file-id",
      "f1",
    ]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
  });

  it("缺少分享输入返回 1", async () => {
    const res: CliResult = await runAlipan(ctx(), ["--file-id", "f1"]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
  });
});

describe("import alipan --path 逐段定位", () => {
  it("按段进目录并下载，subDir 取所在目录", async () => {
    fixtures.pages = {
      root: [folder("dir1", "dir")],
      dir1: [videoFile("fA", "a.mp4")],
    };
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--path", "/dir/a.mp4"]);
    expect(res.code).toBe(0);
    expect(fixtures.listCalls).toEqual([
      { shareId: "s1", parent: "root" },
      { shareId: "s1", parent: "dir1" },
    ]);
    expect(fixtures.pickCalls).toEqual([
      { shareId: "s1", driveId: "d1", fileId: "fA", definition: "AUTO" },
    ]);
    expect(fixtures.downloadCalls).toHaveLength(1);
    expect(fixtures.downloadCalls[0]).toMatchObject({
      m3u8Url: "https://cdn.example/v.m3u8",
      fileId: "fA",
      fileName: "a.mp4",
      template: "HD",
      subDir: "dir",
    });
    expect(res.human).toContain("已下载 a.mp4");
  });

  it("中间目录缺失返回 2", async () => {
    fixtures.pages = { root: [] };
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--path", "/nodir/a.mp4"]);
    expect(res.code).toBe(2);
    expect(res.errorCode).toBe("LOCATE_FAILED");
    expect(res.error).toContain("/nodir");
  });

  it("--path 指向目录（无 --all）返回 1", async () => {
    fixtures.pages = {
      root: [folder("dir1", "dir")],
      dir1: [],
    };
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--path", "/dir"]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
  });

  it("根下文件 subDir 为空串", async () => {
    fixtures.pages = { root: [videoFile("fR", "r.mp4")] };
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--path", "/r.mp4"]);
    expect(res.code).toBe(0);
    expect(fixtures.downloadCalls[0]).toMatchObject({ fileId: "fR", subDir: "" });
  });
});

describe("import alipan 已保存短路", () => {
  it("getStatusBatch 已 saved 时不下载直接返回 0", async () => {
    const savedPath: string = join(target, "r.mp4");
    await writeFile(savedPath, "fake-mp4");
    await recordLedger(dir, "s1", "fR", { path: savedPath, saved_at: 1, template: "HD" });
    fixtures.pages = { root: [videoFile("fR", "r.mp4")] };
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--path", "/r.mp4"]);
    expect(res.code).toBe(0);
    expect(res.human).toContain("已保存");
    expect(fixtures.pickCalls).toHaveLength(0);
    expect(fixtures.downloadCalls).toHaveLength(0);
  });
});

describe("import alipan 批量汇总", () => {
  beforeEach(() => {
    fixtures.pages = {
      root: [videoFile("f1", "a.mp4"), videoFile("f2", "b.mp4"), videoFile("f3", "c.mp4")],
    };
  });

  it("部分失败 code 仍 0，data 含 failed 明细", async () => {
    fixtures.waitImpl = (fileId: string): Promise<string> =>
      fileId === "f2" ? Promise.reject(new Error("boom")) : Promise.resolve(`/tmp/${fileId}.mp4`);
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--all"]);
    expect(res.code).toBe(0);
    expect(res.human).toContain("成功 2 / 失败 1");
    expect(res.human).toContain("b.mp4");
    const data = res.data as { succeeded: Array<{ fileId: string }>; failed: Array<{ file_id: string }> };
    expect(data.succeeded.map((s) => s.fileId)).toEqual(["f1", "f3"]);
    expect(data.failed).toHaveLength(1);
    expect(data.failed[0]).toMatchObject({ file_id: "f2", name: "b.mp4" });
    expect(fixtures.downloadCalls).toHaveLength(3);
  });

  it("全部失败 code 为 2", async () => {
    fixtures.waitImpl = (_fileId: string): Promise<string> => Promise.reject(new Error("boom"));
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--all"]);
    expect(res.code).toBe(2);
    expect(res.errorCode).toBe("BATCH_FAILED");
    expect(res.human).toContain("成功 0 / 失败 3");
  });

  it("--all --dry-run 只列文件不下载", async () => {
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--all", "--dry-run"]);
    expect(res.code).toBe(0);
    expect(res.human).toContain("3 个视频");
    expect(fixtures.pickCalls).toHaveLength(0);
    expect(fixtures.downloadCalls).toHaveLength(0);
  });

  it("目录下无视频文件返回 2", async () => {
    fixtures.pages = { root: [folder("dir1", "dir")] };
    const res: CliResult = await runAlipan(ctx(), [SHARE_URL, "--all"]);
    expect(res.code).toBe(2);
    expect(res.errorCode).toBe("NO_VIDEO");
  });
});
