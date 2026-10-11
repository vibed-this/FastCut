/**
 * `downloadXhsDirect` 单测（vitest，不打真实网络；fetch 全 mock）。
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { downloadXhsDirect, xhsInFlightKey, clearXhsInFlight } from "./downloader.js";
import { getConfig } from "./store.js";

vi.mock("./store.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./store.js")>();
  return {
    ...mod,
    getConfig: vi.fn(async () => ({ target_dir: "", definition: "AUTO" })),
    recordLedger: vi.fn(async () => undefined),
  };
});

function mockVideoFetch(bytes: Uint8Array, total?: number) {
  return vi.fn(async () => {
    const headers = new Headers();
    headers.set("content-length", String(total ?? bytes.length));
    return new Response(bytes as unknown as BodyInit, { status: 200, headers });
  }) as unknown as typeof fetch;
}

function waitDone(emits: { event: string; payload: unknown }[]): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (emits.some((e) => e.event === "download-done")) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 3000);
  });
}

describe("downloadXhsDirect", () => {
  it("空直链抛错", async () => {
    const emit = vi.fn();
    await expect(
      downloadXhsDirect({
        downloadUrl: "   ",
        collectionId: "c1",
        userDataDir: tmpdir(),
        emit,
      }),
    ).rejects.toThrowError(/视频直链为空/);
  });

  it("直链写盘 + sidecar + 进度/完成事件", async () => {
    clearXhsInFlight();
    const target = mkdtempSync(path.join(tmpdir(), "xhs-target-"));
    const userData = mkdtempSync(path.join(tmpdir(), "xhs-user-"));
    vi.mocked(getConfig).mockResolvedValueOnce({ target_dir: target, definition: "AUTO" });
    const bytes = new TextEncoder().encode("fake-mp4-bytes");
    const fetchFn = mockVideoFetch(bytes);
    const emits: { event: string; payload: unknown }[] = [];
    const recordLedger = vi.fn(async () => undefined);
    const ret = await downloadXhsDirect({
      downloadUrl: "https://cdn.example.com/v.mp4",
      collectionId: "mycoll",
      title: "我的视频",
      noteId: "abc123",
      author: "作者",
      cover: "https://x/c.jpg",
      sourceUrl: "https://www.xiaohongshu.com/explore/abc123",
      userDataDir: userData,
      emit: (event, payload) => {
        emits.push({ event, payload });
      },
      recordLedger,
      fetchFn,
    });
    expect(ret).toBe("started");
    await waitDone(emits);
    const done = emits.find((e) => e.event === "download-done");
    expect(done).toBeDefined();
    const payload = done!.payload as { file_id: string; ok: boolean; path?: string };
    expect(payload.ok).toBe(true);
    expect(payload.file_id).toBe(xhsInFlightKey("mycoll", "我的视频"));
    expect(payload.path).toBeDefined();
    expect(existsSync(payload.path!)).toBe(true);
    const metaPath = payload.path!.replace(/\.mp4$/i, "") + ".meta.json";
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    expect(meta["source"]).toBe("xiaohongshu");
    expect(meta["note_id"]).toBe("abc123");
    expect(meta["kind"]).toBe("video");
    expect(meta["title"]).toBe("我的视频");
    const prog = emits.filter((e) => e.event === "download-progress");
    expect(prog.length).toBeGreaterThan(0);
    expect(recordLedger).toHaveBeenCalledOnce();
  });

  it("relDir 优先：落盘到合集真实目录而非 collections/<id> 拼装", async () => {
    clearXhsInFlight();
    const target = mkdtempSync(path.join(tmpdir(), "xhs-target-"));
    const userData = mkdtempSync(path.join(tmpdir(), "xhs-user-"));
    vi.mocked(getConfig).mockResolvedValueOnce({ target_dir: target, definition: "AUTO" });
    const bytes = new TextEncoder().encode("fake-mp4-bytes");
    const fetchFn = mockVideoFetch(bytes);
    const emits: { event: string; payload: unknown }[] = [];
    const recordLedger = vi.fn(async () => undefined);
    const ret = await downloadXhsDirect({
      downloadUrl: "https://cdn.example.com/v.mp4",
      collectionId: "xhs_abc123",
      relDir: "collections/我的合集-abc123",
      title: "标题",
      userDataDir: userData,
      emit: (event, payload) => {
        emits.push({ event, payload });
      },
      recordLedger,
      fetchFn,
    });
    expect(ret).toBe("started");
    await waitDone(emits);
    const done = emits.find((e) => e.event === "download-done");
    const payload = done!.payload as { ok: boolean; path?: string };
    expect(payload.ok).toBe(true);
    expect(payload.path!.startsWith(path.join(target, "collections", "我的合集-abc123"))).toBe(true);
    expect(existsSync(path.join(target, "collections", "xhs_abc123"))).toBe(false);
  });

  it("同一 key 重入返回 downloading", async () => {
    clearXhsInFlight();
    const target = mkdtempSync(path.join(tmpdir(), "xhs-target-"));
    const userData = mkdtempSync(path.join(tmpdir(), "xhs-user-"));
    vi.mocked(getConfig).mockResolvedValue({ target_dir: target, definition: "AUTO" });
    const slowFetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return new Response(new TextEncoder().encode("x"), { status: 200 });
    }) as unknown as typeof fetch;
    const emit = vi.fn();
    const recordLedger = vi.fn(async () => undefined);
    const opts = {
      downloadUrl: "https://cdn.example.com/v.mp4",
      collectionId: "c2",
      title: "重入",
      userDataDir: userData,
      emit,
      recordLedger,
      fetchFn: slowFetch,
    };
    await expect(downloadXhsDirect(opts)).resolves.toBe("started");
    await expect(downloadXhsDirect(opts)).resolves.toBe("downloading");
  });
});
