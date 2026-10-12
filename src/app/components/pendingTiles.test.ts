/** `pendingTiles.ts` 纯逻辑单测（node 环境，无 UI 依赖）。 */
import { describe, expect, it } from "vitest";
import type { ExplorerProgress } from "../store";
import {
  formatBytes,
  pendingDisplayName,
  progressPercent,
  selectXhsPending,
  xhsProgressKeyPrefix,
} from "./pendingTiles";

function prog(over: Partial<ExplorerProgress> & { done: number; total: number }): ExplorerProgress {
  return { ...over };
}

describe("xhsProgressKeyPrefix", () => {
  it("与后端 xhsInFlightKey 同式", () => {
    expect(xhsProgressKeyPrefix("c1")).toBe("xhs:c1:");
  });
});

describe("pendingDisplayName", () => {
  it("落盘名 > 标题 > 回退", () => {
    expect(pendingDisplayName(prog({ done: 0, total: 0, name: "a.mp4" }))).toBe("a.mp4");
    expect(pendingDisplayName(prog({ done: 0, total: 0, title: "标题" }))).toBe("标题.mp4");
    expect(pendingDisplayName(prog({ done: 0, total: 0 }))).toBe("下载中…");
    expect(pendingDisplayName(prog({ done: 0, total: 0, name: "  " }))).toBe("下载中…");
  });
});

describe("selectXhsPending", () => {
  it("只收当前合集前缀 + 落盘目录 + 去重已落盘同名", () => {
    const progress: Record<string, ExplorerProgress> = {
      "xhs:c1:视频A": prog({ done: 10, total: 100, name: "视频A.mp4", relDir: "collections/c1" }),
      "xhs:c1:视频B": prog({ done: 5, total: 50, name: "视频B.mp4", relDir: "collections/c1/sub" }),
      "xhs:c2:视频C": prog({ done: 1, total: 10, name: "视频C.mp4", relDir: "collections/c2" }),
      "share_file_123": prog({ done: 2, total: 8 }),
    };
    // 当前在合集 c1 根：只剩 A（B 在子目录，C 在别合集，alipan key 忽略）。
    const roots = selectXhsPending(progress, "c1", "collections/c1", new Set(["已有.mp4"]));
    expect(roots.map((t) => t.key)).toEqual(["xhs:c1:视频A"]);
    expect(roots[0]?.name).toBe("视频A.mp4");
    // 子目录只剩 B。
    expect(
      selectXhsPending(progress, "c1", "collections/c1/sub", new Set()).map((t) => t.key),
    ).toEqual(["xhs:c1:视频B"]);
    // A 已落盘（同名真实条目）则退场。
    expect(
      selectXhsPending(progress, "c1", "collections/c1", new Set(["视频A.mp4"])),
    ).toEqual([]);
  });

  it("缺 relDir 的旧载荷为兼容仍展示", () => {
    const progress: Record<string, ExplorerProgress> = {
      "xhs:c1:旧": prog({ done: 3, total: 9 }),
    };
    const tiles = selectXhsPending(progress, "c1", "collections/c1", new Set());
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.name).toBe("下载中…");
  });

  it("空映射返回空数组且按 key 稳定排序", () => {
    expect(selectXhsPending(undefined, "c1", "d", new Set())).toEqual([]);
    const progress: Record<string, ExplorerProgress> = {
      "xhs:c1:b": prog({ done: 1, total: 2, name: "b.mp4" }),
      "xhs:c1:a": prog({ done: 1, total: 2, name: "a.mp4" }),
    };
    expect(selectXhsPending(progress, "c1", "d", new Set()).map((t) => t.key)).toEqual([
      "xhs:c1:a",
      "xhs:c1:b",
    ]);
  });
});

describe("progressPercent", () => {
  it("正常百分比与钳制", () => {
    expect(progressPercent(1, 2)).toBe(50);
    expect(progressPercent(0, 10)).toBe(0);
    expect(progressPercent(10, 10)).toBe(100);
    expect(progressPercent(12, 10)).toBe(100);
  });

  it("总量未知/非法时为 null", () => {
    expect(progressPercent(5, 0)).toBeNull();
    expect(progressPercent(5, -1)).toBeNull();
    expect(progressPercent(-1, 10)).toBeNull();
  });
});

describe("formatBytes", () => {
  it("B/KB/MB 进制", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
  });
});
