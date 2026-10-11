/**
 * `share-api.ts` 单测：由旧后端 `share_api.rs` / `store.rs` 的 Rust tests 翻译而来。
 * 全部覆盖纯函数与 mock 注入的客户端逻辑，不打真实网络（CI 无代理不稳定）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearShareTokenCache,
  extract_quick_video_list,
  extract_share_id,
  normalize_limit,
  normalize_marker,
  parse_share_url,
  pick_template,
  resolve_share_name,
  sanitize_segment,
  ShareApiError,
  ShareClient,
} from "./share-api";

beforeEach(() => {
  clearShareTokenCache();
});
import type { VideoPreview } from "../shared/contract";

function template(id: string, width: number, status: string, url: string): VideoPreview {
  return {
    template_id: id,
    template_width: width,
    status,
    preview_url: url,
  };
}

describe("share_id 提取", () => {
  it("取 /s/ 后第一段", () => {
    const url = parse_share_url("https://www.alipan.com/s/wDtnwT8ErHW/folder/abc");
    expect(extract_share_id(url)).toBe("wDtnwT8ErHW");
  });

  it("接受子域名与大小写 host", () => {
    const url = parse_share_url("https://Workspace.aliyundrive.com/s/abc123");
    expect(extract_share_id(url)).toBe("abc123");
  });
});

describe("URL 校验拒绝", () => {
  it("拒绝非分享域名", () => {
    expect(() => parse_share_url("https://example.com/s/abc")).toThrow(
      "仅支持 www.alipan.com 或 *.aliyundrive.com 分享链接",
    );
  });

  it("拒绝非 /s/ 路径", () => {
    expect(() => parse_share_url("https://www.alipan.com/drive/abc")).toThrow(
      "链接路径须以 /s/ 开头",
    );
  });

  it("/s/ 为空时提取失败", () => {
    const parsed = parse_share_url("https://www.alipan.com/s/");
    expect(() => extract_share_id(parsed)).toThrow("链接中缺少 share_id");
  });

  it("拒绝空链接与非 http(s) 开头", () => {
    expect(() => parse_share_url("   ")).toThrow("链接不能为空");
    expect(() => parse_share_url("ftp://www.alipan.com/s/abc")).toThrow(
      "链接须以 http(s):// 开头",
    );
  });
});

describe("档位选择", () => {
  it("AUTO 取宽度最大的可用档（SD/HD/FHD 全 finished 则 FHD 1920）", () => {
    const all = [
      template("SD", 720, "finished", "https://x/SD"),
      template("HD", 1280, "finished", "https://x/HD"),
      template("FHD", 1920, "finished", "https://x/FHD"),
    ];
    expect(pick_template(all, "AUTO")?.template_id).toBe("FHD");
  });

  it("显式档精确命中，miss 回退最高可用档", () => {
    const all = [
      template("SD", 720, "finished", "https://x/SD"),
      template("HD", 1280, "finished", "https://x/HD"),
      template("FHD", 1920, "transcoding", "https://x/FHD"),
    ];
    expect(pick_template(all, "hd")?.template_id).toBe("HD");
    // FHD 转码中不可用：显式 miss 回退到最高可用档 HD
    expect(pick_template(all, "FHD")?.template_id).toBe("HD");
    expect(pick_template(all, "AUTO")?.template_id).toBe("HD");
    expect(pick_template(all, "")?.template_id).toBe("HD");
  });

  it("无可用档时返回 undefined", () => {
    expect(pick_template([template("SD", 720, "transcoding", "")], "AUTO")).toBeUndefined();
    expect(pick_template([], "HD")).toBeUndefined();
  });

  it("从 video_preview_play_info 内嵌 quick_video_list 提取（2026-10-10 实测形状）", () => {
    const raw =
      '{"share_id": "s", "file_id": "f", "category": "quick_video",' +
      '"video_preview_play_info": {"category": "quick_video",' +
      '"meta": {"duration": 4.15, "width": 1080, "height": 1920},' +
      '"quick_video_list": [' +
      '{"template_id": "SD", "template_width": 720, "status": "finished", "preview_url": "https://x/SD"},' +
      '{"template_id": "FHD", "template_width": 1920, "status": "finished", "preview_url": "https://x/FHD"}]}}';
    const list = extract_quick_video_list(JSON.parse(raw) as Parameters<typeof extract_quick_video_list>[0]);
    expect(list).toHaveLength(2);
    expect(pick_template(list, "AUTO")?.template_id).toBe("FHD");
  });
});

describe("分享元信息取名", () => {
  it("优先 share_name", () => {
    expect(resolve_share_name({ share_name: "我的分享" })).toBe("我的分享");
  });

  it("回退 display_name 再 title", () => {
    expect(resolve_share_name({ display_name: "展示名", title: "标题" })).toBe("展示名");
    expect(resolve_share_name({ title: "只有标题" })).toBe("只有标题");
  });

  it("全缺失时回退未命名分享", () => {
    expect(resolve_share_name({})).toBe("未命名分享");
    expect(resolve_share_name({ share_name: "   " })).toBe("未命名分享");
  });
});

describe("sanitize_segment", () => {
  it("去斜杠反斜杠与空字符并 trim", () => {
    expect(sanitize_segment("  a/b\\c  ")).toBe("abc");
    expect(sanitize_segment("a\0b")).toBe("ab");
  });

  it("空结果回退未命名", () => {
    expect(sanitize_segment("///")).toBe("未命名");
    expect(sanitize_segment("   ")).toBe("未命名");
  });

  it("截断到 100 字符", () => {
    expect([...sanitize_segment("名".repeat(150))]).toHaveLength(100);
  });
});

describe("marker / limit 归一化", () => {
  it("空白 marker 视为从头取", () => {
    expect(normalize_marker(undefined)).toBeUndefined();
    expect(normalize_marker("")).toBeUndefined();
    expect(normalize_marker("   ")).toBeUndefined();
    expect(normalize_marker(" abc ")).toBe("abc");
  });

  it("limit 越界收敛到 100", () => {
    expect(normalize_limit(undefined)).toBe(100);
    expect(normalize_limit(0)).toBe(100);
    expect(normalize_limit(-5)).toBe(100);
    expect(normalize_limit(101)).toBe(100);
    expect(normalize_limit(50)).toBe(50);
    expect(normalize_limit(1)).toBe(1);
    expect(normalize_limit(100)).toBe(100);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("share_token 缓存", () => {
  it("命中缓存时不发网络请求", async () => {
    const fetchFn = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse({ share_token: "cached", expires_in: 7200 }));
    const client = new ShareClient("s1", undefined, fetchFn as typeof fetch);
    await expect(client.shareToken()).resolves.toBe("cached");
    await expect(client.shareToken()).resolves.toBe("cached");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://api.aliyundrive.com/v2/share_link/get_share_token",
    );
  });
});

describe("ShareLinkTokenInvalid 刷新重试", () => {
  it("失效后刷新 token 重试一次并透出分页结果", async () => {
    const seenTokens: Array<string | null> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v2/share_link/get_share_token")) {
        const n = fetchFn.mock.calls.filter((c) => String(c[0]).endsWith("get_share_token")).length;
        return jsonResponse({ share_token: n === 1 ? "t1" : "t2", expires_in: 7200 });
      }
      const headers = new Headers(init?.headers);
      seenTokens.push(headers.get("x-share-token"));
      if (seenTokens.length === 1) {
        return jsonResponse({ code: "ShareLinkTokenInvalid", message: "token 无效" }, 403);
      }
      return jsonResponse({
        items: [
          { file_id: "f2", drive_id: "d1", name: "b.mp4", type: "file", size: 6331692, category: "video", file_extension: "mp4" },
        ],
        next_marker: "",
      });
    });

    const client = new ShareClient("s1", undefined, fetchFn as typeof fetch);
    const page = await client.listShare("root");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.file_extension).toBe("mp4");
    expect(page.next_marker).toBe("");
    expect(seenTokens).toEqual(["t1", "t2"]);
  });

  it("非 token 错误直接透出中文文案", async () => {
    const fetchFn = vi.fn(async (url: unknown) =>
      String(url).endsWith("get_share_token")
        ? jsonResponse({ share_token: "t", expires_in: 7200 })
        : jsonResponse({ code: "NotFound", message: "无此分享" }, 404),
    );
    const client = new ShareClient("s1", undefined, fetchFn as typeof fetch);
    await expect(client.listShare("root")).rejects.toThrow("接口错误（NotFound）：无此分享");
    // 非 ShareApiError 不会被误判
    expect(new ShareApiError("Other", "x").code).toBe("Other");
  });
});

describe("listShare 请求形状", () => {
  it("默认 limit 100、排序字段齐全、空 marker 不下发", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("get_share_token")) {
        return jsonResponse({ share_token: "t", expires_in: 7200 });
      }
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Canary")).toBe("client=web,app=share,version=v2.3.1");
      expect(headers.get("Referer")).toBe("https://www.alipan.com/");
      expect(headers.get("User-Agent")).toContain("Chrome/154");
      expect(headers.get("x-device-id")).toBeTruthy();
      return jsonResponse({ items: [], next_marker: "" });
    });
    const client = new ShareClient("s1", undefined, fetchFn as typeof fetch);
    await client.listShare("", "   ");
    expect(sentBody).toMatchObject({
      share_id: "s1",
      parent_file_id: "root",
      limit: 100,
      image_thumbnail_process: "image/resize,w_256/format,jpeg",
      video_thumbnail_process: "video/snapshot,t_1000,f_jpg,ar_auto,w_256",
      order_by: "name",
      order_direction: "ASC",
    });
    expect(sentBody).not.toHaveProperty("marker");
  });

  it("跨实例复用 token：第二个同 share 客户端不再取 token", async () => {
    let tokenCalls = 0;
    const fetchFn = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("get_share_token")) {
        tokenCalls += 1;
        return jsonResponse({ share_token: "shared-t", expires_in: 7200 });
      }
      return jsonResponse({ items: [], next_marker: "" });
    });
    const a = new ShareClient("reuse-s", undefined, fetchFn as typeof fetch);
    await a.listShare("root");
    const b = new ShareClient("reuse-s", undefined, fetchFn as typeof fetch);
    await b.listShare("root");
    expect(tokenCalls).toBe(1);
  });

  it("TooManyRequests 退避重试一次后成功", async () => {
    let listCalls = 0;
    const fetchFn = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("get_share_token")) {
        return jsonResponse({ share_token: "t", expires_in: 7200 });
      }
      listCalls += 1;
      if (listCalls === 1) {
        return jsonResponse({ code: "TooManyRequests", message: "too many requests" }, 429);
      }
      return jsonResponse({ items: [], next_marker: "" });
    });
    const client = new ShareClient("retry-s", undefined, fetchFn as typeof fetch);
    await expect(client.listShare("root")).resolves.toMatchObject({ next_marker: "" });
    expect(listCalls).toBe(2);
  });
});
