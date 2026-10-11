/**
 * thumbnail-cache.ts 的 vitest 测试：路径清洗、淘汰规划、warm/local/clear roundtrip。
 * 全部以临时目录充当 userDataDir；fetch 用 stub 注入，不碰网络。
 */
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cacheFilePath,
  clearShareThumbnails,
  localThumbnail,
  planEviction,
  sanitizeSegment,
  toThumbMediaUrl,
  warmThumbnails,
} from "./thumbnail-cache.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastcut-thumb-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sanitizeSegment", () => {
  it("放行常规 id", () => {
    expect(sanitizeSegment("abc-123_X.y")).toBe("abc-123_X.y");
  });
  it("../ 与空串不会穿出目录", () => {
    expect(sanitizeSegment("../../etc")).not.toContain("/");
    expect(sanitizeSegment("")).toBe("_");
    expect(sanitizeSegment("..")).toBe("_");
  });
});

describe("路径与 URL", () => {
  it("cacheFilePath 落在 userDataDir/thumbnails 下", () => {
    const p = cacheFilePath(dir, "share1", "file1");
    expect(p.startsWith(join(dir, "thumbnails"))).toBe(true);
    expect(p.endsWith(".jpg")).toBe(true);
  });
  it("toThumbMediaUrl 走 media 协议", () => {
    expect(toThumbMediaUrl("/a b/c.jpg")).toBe("media://file/a%20b/c.jpg");
  });
});

describe("planEviction", () => {
  const files = [
    { path: "/c/old.jpg", size: 100, atimeMs: 1 },
    { path: "/c/mid.jpg", size: 100, atimeMs: 2 },
    { path: "/c/new.jpg", size: 100, atimeMs: 3 },
  ];
  it("水位线内不删", () => {
    expect(planEviction(files, 300, 3)).toEqual([]);
  });
  it("超字节从最旧删到线下", () => {
    expect(planEviction(files, 200, 10)).toEqual(["/c/old.jpg"]);
  });
  it("超文件数同样淘汰最旧", () => {
    expect(planEviction(files, 10 ** 9, 2)).toEqual(["/c/old.jpg"]);
  });
});

describe("warm/local/clear", () => {
  const stubFetch = (n: number) => async (_url: string) => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array(n).buffer as ArrayBuffer,
  });

  it("warm 下载缺失项并返回本地 URL，二次 warm 直接命中不抓取", async () => {
    let calls = 0;
    const counting = async (url: string) => {
      calls += 1;
      return stubFetch(64)(url);
    };
    const first = await warmThumbnails(
      dir,
      "s1",
      [{ fileId: "f1", url: "https://x/thumb1" }],
      counting,
    );
    expect(calls).toBe(1);
    expect(first["f1"]?.startsWith("media://file")).toBe(true);
    const st = await stat(cacheFilePath(dir, "s1", "f1"));
    expect(st.size).toBe(64);

    const second = await warmThumbnails(
      dir,
      "s1",
      [{ fileId: "f1", url: "https://x/thumb1-new-signed-url" }],
      counting,
    );
    // file_id 寻址：URL 变了也不重下
    expect(calls).toBe(1);
    expect(second["f1"]).toBe(first["f1"]);
  });

  it("失败项跳过（无 URL/抓取抛错/空包），不影响其他项", async () => {
    const flaky = async (url: string) => {
      if (url === "bad") throw new Error("net down");
      if (url === "empty") return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
      return stubFetch(10)(url);
    };
    const out = await warmThumbnails(
      dir,
      "s1",
      [
        { fileId: "a", url: "" },
        { fileId: "b", url: "bad" },
        { fileId: "c", url: "empty" },
        { fileId: "d", url: "good" },
      ],
      flaky,
    );
    expect(Object.keys(out)).toEqual(["d"]);
  });

  it("localThumbnail 命中返回 URL 并 touch，未命中 null", async () => {
    expect(await localThumbnail(dir, "s1", "nope")).toBeNull();
    await mkdir(join(dir, "thumbnails", "s1"), { recursive: true });
    await writeFile(join(dir, "thumbnails", "s1", "f9.jpg"), new Uint8Array(8));
    const url = await localThumbnail(dir, "s1", "f9");
    expect(url?.startsWith("media://file")).toBe(true);
  });

  it("clearShareThumbnails 只清指定分享", async () => {
    await warmThumbnails(dir, "s1", [{ fileId: "f1", url: "u" }], stubFetch(8));
    await warmThumbnails(dir, "s2", [{ fileId: "f2", url: "u" }], stubFetch(8));
    await clearShareThumbnails(dir, "s1");
    expect(await localThumbnail(dir, "s1", "f1")).toBeNull();
    expect(await localThumbnail(dir, "s2", "f2")).not.toBeNull();
    const rest = await readdir(join(dir, "thumbnails"));
    expect(rest).toEqual(["s2"]);
  });
});
