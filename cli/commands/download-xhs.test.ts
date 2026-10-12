/**
 * `cli/commands/download-xhs.ts` 的 vitest 测试（不打真实网络）。
 *
 * 覆盖：用法错误、dry-run 不落盘且 stdout/data 无签名直链、
 * 拍平计划命名（单文件无序号/多文件 `_01` 起）、真实落盘（fetch 打桩）。
 */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { XhsParseResult } from "../../electron/main/xhs-client.js";
import type { CliContext, CliResult } from "../lib/context.js";
import { buildFlatPlan, extFromUrl, runDownloadXhs } from "./download-xhs.js";

const fixtures: {
  parseImpl: (url: string) => Promise<XhsParseResult>;
} = vi.hoisted(() => ({
  parseImpl: (_url: string): Promise<XhsParseResult> =>
    Promise.resolve({
      title: "",
      downloadUrl: "",
      cover: "",
      noteId: "",
      author: "",
      kind: "video",
      videoUrls: [],
      images: [],
    }),
}));

vi.mock("../../electron/main/xhs-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../electron/main/xhs-client.js")>();
  class StubXhsClient {
    parse(url: string): Promise<XhsParseResult> {
      return fixtures.parseImpl(url);
    }
  }
  return { ...actual, XhsClient: StubXhsClient };
});

const XHS_URL = "https://www.xiaohongshu.com/explore/abc123";

const MIXED: XhsParseResult = {
  title: "我的帖子",
  downloadUrl: "https://sns-video-hw.xhscdn.com/stream/1/v1.mp4?sign=AAA&t=1",
  cover: "https://sns-img-hw.xhscdn.com/notes_pre_post/a?imageView2/2/w/0/format/jpg",
  noteId: "abc123",
  author: "作者",
  kind: "mixed",
  videoUrls: [
    "https://sns-video-hw.xhscdn.com/stream/1/v1.mp4?sign=AAA&t=1",
    "https://sns-video-hw.xhscdn.com/stream/1/v2.mp4?sign=BBB&t=1",
  ],
  images: [
    "https://sns-img-hw.xhscdn.com/notes_pre_post/a?imageView2/2/w/0/format/jpg",
    "https://sns-img-hw.xhscdn.com/note_pre_post_uhdr/b?imageView2/2/w/0/format/png",
  ],
};

function ctx(): CliContext {
  return { userDataDir: tmpdir(), json: false, verbose: false };
}

/** 按 content-type 返回最小字节的 fetch 桩。 */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const u: string = String(input);
      const isVideo: boolean = u.includes("/stream/");
      const bytes = new TextEncoder().encode(isVideo ? "fake-video" : "fake-image");
      const headers = new Headers();
      headers.set("content-type", isVideo ? "video/mp4" : "image/jpeg");
      headers.set("content-length", String(bytes.length));
      return new Response(bytes as unknown as BodyInit, { status: 200, headers });
    }),
  );
}

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastcut-dl-xhs-"));
  fixtures.parseImpl = () => Promise.resolve({ ...MIXED });
  stubFetch();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("download xhs 参数校验", () => {
  it("缺 url 返回 1", async () => {
    const res: CliResult = await runDownloadXhs(ctx(), ["xhs"]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
  });

  it("非小红书链接返回 1", async () => {
    const res: CliResult = await runDownloadXhs(ctx(), ["xhs", "https://www.alipan.com/s/abc"]);
    expect(res.code).toBe(1);
    expect(res.errorCode).toBe("USAGE");
  });
});

describe("buildFlatPlan / extFromUrl", () => {
  it("多文件拍平按 _01 起编号、视频在前图片在后", () => {
    const plan = buildFlatPlan(MIXED, undefined);
    expect(plan.map((p) => p.fileName)).toEqual([
      "我的帖子_01.mp4",
      "我的帖子_02.mp4",
      "我的帖子_03.jpg",
      "我的帖子_04.png",
    ]);
  });

  it("单文件无序号", () => {
    const plan = buildFlatPlan(
      {
        ...MIXED,
        kind: "video",
        videoUrls: ["https://x/v.mp4"],
        images: [],
        downloadUrl: "https://x/v.mp4",
      },
      undefined,
    );
    expect(plan.map((p) => p.fileName)).toEqual(["我的帖子.mp4"]);
  });

  it("xhscdn 无后缀形从 format 取扩展名", () => {
    expect(extFromUrl("https://sns-img-hw.xhscdn.com/a?imageView2/2/w/0/format/jpg", "image")).toBe(
      "jpg",
    );
    expect(extFromUrl("https://x/v.mp4?sign=AAA&t=1", "video")).toBe("mp4");
  });
});

describe("download xhs dry-run", () => {
  it("不落盘、human/data 无签名直链", async () => {
    const out = join(dir, "dry");
    const res: CliResult = await runDownloadXhs(ctx(), ["xhs", XHS_URL, "--out", out, "--dry-run"]);
    expect(res.code).toBe(0);
    expect(res.human).toContain("mixed");
    expect(res.human).toContain("待下载：我的帖子_01.mp4");
    await expect(stat(out)).rejects.toThrow();
    const dumped: string = JSON.stringify(res.data) + res.human;
    expect(dumped).not.toContain("sign=");
    expect(dumped).not.toContain("xhscdn.com");
  });
});

describe("download xhs 落盘", () => {
  it("混合 4 文件拍平同一目录、无子目录", async () => {
    const out = join(dir, "flat");
    const res: CliResult = await runDownloadXhs(ctx(), ["xhs", XHS_URL, "--out", out]);
    expect(res.code).toBe(0);
    const names: string[] = (await readdir(out)).sort();
    // 第 4 项计划名为 .png，但桩 content-type 为 image/jpeg，落盘时被纠正为 .jpg
    expect(names).toEqual([
      "我的帖子_01.mp4",
      "我的帖子_02.mp4",
      "我的帖子_03.jpg",
      "我的帖子_04.jpg",
    ]);
    const data = res.data as { paths: string[]; kind: string };
    expect(data.kind).toBe("mixed");
    expect(data.paths).toHaveLength(4);
    const head: string = await readFile(join(out, names[0] as string), "utf8");
    expect(head).toBe("fake-video");
    const dumped: string = JSON.stringify(res.data) + res.human;
    expect(dumped).not.toContain("sign=");
  });

  it("纯图文只有图片", async () => {
    fixtures.parseImpl = () =>
      Promise.resolve({
        title: "图集",
        downloadUrl: "",
        cover: "",
        noteId: "n1",
        author: "",
        kind: "image",
        videoUrls: [],
        images: ["https://s/x/1?imageView2/2/w/0/format/jpg"],
      });
    const out = join(dir, "img");
    const res: CliResult = await runDownloadXhs(ctx(), ["xhs", XHS_URL, "--out", out]);
    expect(res.code).toBe(0);
    expect(await readdir(out)).toEqual(["图集.jpg"]);
  });
});
