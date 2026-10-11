/** local-thumb.ts 单测：缓存键/路径纯函数 + ffmpeg 真抽帧 roundtrip。 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ffmpegStatic from "ffmpeg-static";

import {
  localThumbKey,
  localThumbPath,
  localVideoThumbnail,
  snapshotVideo,
  warmLocalVideoThumbnails,
} from "./local-thumb.js";
const FFMPEG = ffmpegStatic as string;

let userData = "";
let target = "";

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "fastcut-thumb-user-"));
  target = await mkdtemp(join(tmpdir(), "fastcut-thumb-target-"));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

/** 用 testsrc 生成指定时长的 mp4（无音频，libx264）。 */
function makeMp4(out: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=duration=${seconds}:size=160x120:rate=10`,
      "-pix_fmt",
      "yuv420p",
      out,
    ]);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`gen ${code}`))));
  });
}

describe("localThumbKey / localThumbPath", () => {
  it("同输入同键，mtime 变化换键", () => {
    const a = localThumbKey("/x/v.mp4", 10, 1000);
    expect(localThumbKey("/x/v.mp4", 10, 1000)).toBe(a);
    expect(localThumbKey("/x/v.mp4", 10, 2000)).not.toBe(a);
    expect(localThumbKey("/x/w.mp4", 10, 1000)).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("路径落在 thumbnails/local 下", () => {
    expect(localThumbPath(userData, "abc")).toBe(join(userData, "thumbnails", "local", "abc.jpg"));
  });
});

describe("snapshotVideo（真 ffmpeg）", () => {
  it("2s 视频抽帧为 JPEG", async () => {
    const src = join(target, "v.mp4");
    await makeMp4(src, 2);
    const out = join(target, "v.jpg");
    await snapshotVideo(FFMPEG, src, out);
    const buf = await readFile(out);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
    expect(buf[2]).toBe(0xff);
  }, 30_000);

  it("0.5s 短视频回退首帧仍成功", async () => {
    const src = join(target, "short.mp4");
    await makeMp4(src, 0.5);
    const out = join(target, "short.jpg");
    await snapshotVideo(FFMPEG, src, out);
    const s = await stat(out);
    expect(s.size).toBeGreaterThan(0);
  }, 30_000);

  it("不存在的源抛错", async () => {
    await expect(
      snapshotVideo(FFMPEG, join(target, "missing.mp4"), join(target, "o.jpg")),
    ).rejects.toThrow();
  }, 30_000);
});

describe("warmLocalVideoThumbnails", () => {
  it("生成→命中，目录/不存在/越界跳过", async () => {
    const src = join(target, "v.mp4");
    await makeMp4(src, 2);
    await writeFile(join(target, "n.txt"), "x");
    const first = await warmLocalVideoThumbnails(userData, target, [
      "v.mp4",
      "n.txt",
      "missing.mp4",
      "../up.mp4",
    ]);
    expect(Object.keys(first.cached)).toEqual(["v.mp4"]);
    expect(first.cached["v.mp4"]).toMatch(/^media:\/\/file\//);
    // 第二次走缓存命中
    const second = await warmLocalVideoThumbnails(userData, target, ["v.mp4"]);
    expect(second.cached["v.mp4"]).toBe(first.cached["v.mp4"]);
    // 缓存文件真实存在：按 key 正查返回同一 URL
    const st = await stat(src);
    const key = localThumbKey(src, st.size, st.mtimeMs);
    await expect(localVideoThumbnail(userData, key)).resolves.toBe(first.cached["v.mp4"]);
  }, 60_000);

  it("空数组直接返回空", async () => {
    await expect(warmLocalVideoThumbnails(userData, target, [])).resolves.toEqual({ cached: {} });
  });
});
