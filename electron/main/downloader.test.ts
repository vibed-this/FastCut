/**
 * `electron/main/downloader.ts` 单测（vitest，不联网）。
 * 翻译自 `src-tauri/src/downloader.rs` 的 Rust tests（6 个 case）+ unique_mp4_path 去重。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parse_segments,
  resolve_segment,
  resolve_target_dir,
  unique_mp4_path,
} from "./downloader.js";

describe("parse_segments", () => {
  it("相对分片继承签名 query", () => {
    const base = "https://preview.example.com/a/b/playlist.m3u8?x-oss-expires=123&sig=abc";
    const body =
      "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg0.ts\n#EXTINF:10.0,\n/abs/seg1.ts?tok=1\n#EXTINF:10.0,\nhttps://cdn.example.com/s2.ts\n#EXT-X-ENDLIST\n";
    expect(parse_segments(base, body)).toEqual([
      "https://preview.example.com/a/b/seg0.ts?x-oss-expires=123&sig=abc",
      "https://preview.example.com/abs/seg1.ts?tok=1",
      "https://cdn.example.com/s2.ts",
    ]);
  });

  it("加密流拒绝", () => {
    const body = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.key"\nseg0.ts\n';
    expect(() => parse_segments("https://x/y.m3u8", body)).toThrowError(/加密流不支持/);
  });
});

describe("resolve_segment", () => {
  it("根相对丢 query", () => {
    expect(resolve_segment("https://h.example.com/x/y.m3u8", "/r/s.ts")).toBe(
      "https://h.example.com/r/s.ts",
    );
  });
});

describe("resolve_target_dir", () => {
  it("空 sub_dir 即 base", () => {
    const base = path.join(tmpdir(), "base");
    expect(resolve_target_dir(base, "")).toBe(base);
    expect(resolve_target_dir(base, "   ")).toBe(base);
  });

  it("嵌套逐段清洗", () => {
    const base = path.join(tmpdir(), "base");
    expect(resolve_target_dir(base, "分享名/子/目录")).toBe(
      path.join(base, "分享名", "子", "目录"),
    );
    expect(resolve_target_dir(base, "a//b")).toBe(path.join(base, "a", "b"));
  });

  it("绝对路径与 dotdot 拒绝", () => {
    const base = path.join(tmpdir(), "base");
    expect(() => resolve_target_dir(base, "/abs/dir")).toThrowError();
    expect(() => resolve_target_dir(base, "../up")).toThrowError();
    expect(() => resolve_target_dir(base, "a/../b")).toThrowError();
    expect(() => resolve_target_dir(base, "a/..")).toThrowError();
  });
});

describe("unique_mp4_path", () => {
  it("已存在加 (n) 后缀、空 stem 回退 video", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dl-"));
    writeFileSync(path.join(dir, "video.mp4"), "x");
    expect(unique_mp4_path(dir, "clip.mp4")).toBe(path.join(dir, "clip.mp4"));
    expect(unique_mp4_path(dir, "video.mp4")).toBe(path.join(dir, "video (1).mp4"));
    writeFileSync(path.join(dir, "video (1).mp4"), "x");
    expect(unique_mp4_path(dir, "video.mp4")).toBe(path.join(dir, "video (2).mp4"));
    expect(unique_mp4_path(dir, "")).toBe(path.join(dir, "video (2).mp4"));
  });
});
