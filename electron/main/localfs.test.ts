/** localfs.ts 单测：全部以临时目录充当 target_dir，不碰真实数据。 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { fsList, fsMkdir, fsMove, fsRemove, fsRename, resolveRel } from "./localfs.js";

let target = "";

beforeEach(async () => {
  target = await mkdtemp(join(tmpdir(), "fastcut-localfs-"));
});

afterEach(async () => {
  await rm(target, { recursive: true, force: true });
});

describe("resolveRel", () => {
  it("空串指向根", () => {
    expect(resolveRel(target, "")).toBe(target);
  });

  it("拒绝绝对路径与 ..", () => {
    expect(() => resolveRel(target, "/abs")).toThrow();
    expect(() => resolveRel(target, "../up")).toThrow();
    expect(() => resolveRel(target, "a/../../up")).toThrow();
  });
});

describe("fsMkdir / fsList", () => {
  it("mkdir -p 建嵌套目录并列出", async () => {
    await fsMkdir(target, "a/b");
    await writeFile(join(target, "a", "b", "n.txt"), "hi");
    const root = await fsList(target, "");
    expect(root.map((i) => i.name)).toEqual(["a"]);
    expect(root[0]).toMatchObject({ relPath: "a", isDir: true });
    const inner = await fsList(target, "a/b");
    expect(inner).toHaveLength(1);
    expect(inner[0]).toMatchObject({ name: "n.txt", relPath: "a/b/n.txt", isDir: false, size: 2 });
    expect(typeof inner[0]?.mtime).toBe("number");
  });

  it("空目录名抛错", async () => {
    await expect(fsMkdir(target, "   ")).rejects.toThrow("目录名不能为空");
  });
});

describe("fsRename", () => {
  it("同目录重命名", async () => {
    await fsMkdir(target, "dir");
    await writeFile(join(target, "dir", "old.txt"), "x");
    await fsRename(target, "dir/old.txt", "new.txt");
    const items = await fsList(target, "dir");
    expect(items.map((i) => i.name)).toEqual(["new.txt"]);
  });

  it("目标存在不覆盖", async () => {
    await writeFile(join(target, "a.txt"), "a");
    await writeFile(join(target, "b.txt"), "b");
    await expect(fsRename(target, "a.txt", "b.txt")).rejects.toThrow("目标已存在");
  });

  it("根目录与不存在抛错", async () => {
    await expect(fsRename(target, "", "x")).rejects.toThrow("不能重命名根目录");
    await expect(fsRename(target, "missing.txt", "x")).rejects.toThrow("文件或目录不存在");
    await expect(fsRename(target, "a.txt", "   ")).rejects.toThrow("名称不能为空");
  });
});

describe("fsMove", () => {
  it("移动到目标目录并保留原名", async () => {
    await fsMkdir(target, "src");
    await fsMkdir(target, "dest");
    await writeFile(join(target, "src", "m.txt"), "x");
    await fsMove(target, "src/m.txt", "dest");
    expect(await readFile(join(target, "dest", "m.txt"), "utf8")).toBe("x");
    await expect(fsList(target, "src")).resolves.toEqual([]);
  });

  it("目标存在不覆盖，移入自身拒绝", async () => {
    await fsMkdir(target, "s");
    await writeFile(join(target, "s", "f.txt"), "x");
    await fsMkdir(target, "d");
    await writeFile(join(target, "d", "f.txt"), "y");
    await expect(fsMove(target, "s/f.txt", "d")).rejects.toThrow("目标已存在");
    await expect(fsMove(target, "s", "s/sub")).rejects.toThrow("不能移动到自身或子目录");
  });
});

describe("fsRemove", () => {
  it("递归删除目录", async () => {
    await fsMkdir(target, "gone/sub");
    await writeFile(join(target, "gone", "sub", "f.txt"), "x");
    await fsRemove(target, "gone");
    await expect(fsList(target, "")).resolves.toEqual([]);
  });

  it("拒绝删除根目录", async () => {
    await expect(fsRemove(target, "")).rejects.toThrow("不能删除根目录");
    await expect(fsRemove(target, "   ")).rejects.toThrow("不能删除根目录");
  });
});

describe("sidecar（*.meta.json）", () => {
  it("fsList 隐藏 sidecar，只显示视频", async () => {
    await writeFile(join(target, "v.mp4"), "x");
    await writeFile(join(target, "v.meta.json"), "{}");
    const items = await fsList(target, "");
    expect(items.map((i) => i.name)).toEqual(["v.mp4"]);
  });

  it("删除视频跟随删除 sidecar", async () => {
    await writeFile(join(target, "v.mp4"), "x");
    await writeFile(join(target, "v.meta.json"), "{}");
    await writeFile(join(target, "keep.mp4"), "y");
    await fsRemove(target, "v.mp4");
    const items = await fsList(target, "");
    expect(items.map((i) => i.name)).toEqual(["keep.mp4"]);
  });

  it("移动视频跟随移动 sidecar", async () => {
    await fsMkdir(target, "dest");
    await writeFile(join(target, "v.mp4"), "x");
    await writeFile(join(target, "v.meta.json"), "{}");
    await fsMove(target, "v.mp4", "dest");
    expect(await readFile(join(target, "dest", "v.mp4"), "utf8")).toBe("x");
    expect(await readFile(join(target, "dest", "v.meta.json"), "utf8")).toBe("{}");
    await expect(fsList(target, "")).resolves.toEqual([
      expect.objectContaining({ name: "dest", isDir: true }),
    ]);
  });

  it("重命名视频跟随重命名 sidecar", async () => {
    await writeFile(join(target, "a.mp4"), "x");
    await writeFile(join(target, "a.meta.json"), "{}");
    await fsRename(target, "a.mp4", "b.mp4");
    expect(await readFile(join(target, "b.meta.json"), "utf8")).toBe("{}");
    const items = await fsList(target, "");
    expect(items.map((i) => i.name)).toEqual(["b.mp4"]);
  });
});
