/**
 * `electron/main/xhs-client.ts` 单测（vitest，不打真实网络；网络分支全 mock）。
 * 纯函数用固定向量；加解密向量见文件头注释的生成方式。
 */
import { createDecipheriv, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  XhsClient,
  blockReverse,
  customB64decode,
  customB64encode,
  decryptPayload,
  extractNoteId,
  pickVideoUrl,
  sanitizeTitle,
  xorString,
} from "./xhs-client.js";

function latin1(b64: string): string {
  return Buffer.from(b64, "base64").toString("latin1");
}

describe("xorString", () => {
  it("固定向量：'a'^0x5A=';'", () => {
    expect(xorString("a")).toBe(";");
    expect(xorString("AB")).toBe("\x1b\x18");
  });

  it("双重 XOR 还原", () => {
    expect(xorString(xorString("hello-123"))).toBe("hello-123");
  });
});

describe("blockReverse", () => {
  it("固定向量：8 字节分块反转", () => {
    expect(blockReverse("123456789")).toBe("876543219");
    expect(blockReverse("abcd", 2)).toBe("badc");
    expect(blockReverse("")).toBe("");
  });
});

describe("customB64decode", () => {
  it("固定向量：表头映射 + 填充保留", () => {
    // CUSTOM[0]='Z' → STANDARD[0]='A'
    expect(customB64decode("Z")).toBe("A");
    expect(customB64decode("=")).toBe("=");
    expect(customB64decode("ZYX+/")).toBe("ABC+/");
  });

  it("encode/decode 互逆", () => {
    const std = "Aa09+/==";
    expect(customB64decode(customB64encode(std))).toBe(std);
  });
});

describe("sanitizeTitle", () => {
  it("去掉非法字符", () => {
    expect(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
  });

  it("空标题回退未命名、超长截断 100 字符", () => {
    expect(sanitizeTitle("   ")).toBe("未命名");
    expect(sanitizeTitle('<>:"/\\|?*')).toBe("未命名");
    expect([...sanitizeTitle("a".repeat(200))].length).toBe(100);
  });
});

describe("decryptPayload", () => {
  // 生成：明文 {"title":"hello test","url":"https://example.com/v.mp4","cover":"https://example.com/c.jpg"}，
  // IV=00112233445566778899aabbccddeeff，AES-256-CBC key=sha256("12345678901234567890123456789013")，
  // 再经 customB64encode→blockReverse(8)→xor(0x5A)，latin1 bytes 取 b64（可打印固定向量）。
  const DATA_ENC_B64 =
    "Ey0rHQIwNx0QPCIzFRsWaxgtMSJ3DCoqAiBvGWg+Fj4eAj0KYxwpHjEYdzw9Fj0jLBMXOG0fbjQ8NDUAEDQeMQUYGQkQKgIIHi0zFyAAOW1sOSgWMWgcbCB3OQMVLQAJMSsQHy8ZGBQ7AwlpNDgtAjkuAmI8NG5jOzQcaA0sGQs=";
  const IV_ENC_B64 = "CRVjEDwYAwBoNCAwHDgxDWdnLgUobBEt";

  it("固定向量解密出 title/url/cover", () => {
    const raw = decryptPayload(latin1(DATA_ENC_B64), latin1(IV_ENC_B64));
    expect(raw["title"]).toBe("hello test");
    expect(raw["url"]).toBe("https://example.com/v.mp4");
    expect(raw["cover"]).toBe("https://example.com/c.jpg");
  });

  it("损坏载荷抛解密失败", () => {
    expect(() => decryptPayload("!!!", "???")).toThrowError(/解析结果解密失败/);
  });
});

describe("extractNoteId", () => {
  it("长链提取、短链/非法留空不抛", () => {
    expect(
      extractNoteId("https://www.xiaohongshu.com/explore/68f1a2b3000000001b02c3d4?x=1"),
    ).toBe("68f1a2b3000000001b02c3d4");
    expect(
      extractNoteId("https://www.xiaohongshu.com/discovery/item/68f1a2b3000000001b02c3d4"),
    ).toBe("68f1a2b3000000001b02c3d4");
    expect(extractNoteId("https://xhslink.com/aBc123")).toBe("");
    expect(extractNoteId("not a url")).toBe("");
    expect(extractNoteId("")).toBe("");
  });
});

describe("XhsClient.buildParseBody", () => {
  it("形状正确且 GCM 载荷可解密回 requestURL", () => {
    const c = new XhsClient(async () => new Response("{}", { status: 200 }));
    const body = c.buildParseBody("https://www.xiaohongshu.com/explore/abc", "K", "S");
    expect(body["version"]).toBe(3);
    expect(body["k_970b03"]).toBe("K");
    expect(body["r_970b03"]).toBe(1);
    expect(typeof body["p_970b03"]).toBe("string");
    expect(typeof body["i_970b03"]).toBe("string");
    // 用同一 key/seed 解回 params
    const keyBytes = createHash("sha256").update("K:S", "utf8").digest();
    const iv = Buffer.from(body["i_970b03"] as string, "base64");
    const raw = Buffer.from(body["p_970b03"] as string, "base64");
    const ct = raw.subarray(0, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    const d = createDecipheriv("aes-256-gcm", keyBytes, iv);
    d.setAuthTag(tag);
    const params = JSON.parse(
      Buffer.concat([d.update(ct), d.final()]).toString("utf8"),
    ) as Record<string, unknown>;
    expect(params["requestURL"]).toBe("https://www.xiaohongshu.com/explore/abc");
    expect(params["pagePath"]).toBe("/xiaohongshu");
    expect(params["qualityTier"]).toBe("standard");
  });

  it("qualityTier 可覆盖为 hd", () => {
    const c = new XhsClient(async () => new Response("{}", { status: 200 }));
    const body = c.buildParseBody("https://www.xiaohongshu.com/explore/abc", "K", "S", "hd");
    const keyBytes = createHash("sha256").update("K:S", "utf8").digest();
    const iv = Buffer.from(body["i_970b03"] as string, "base64");
    const raw = Buffer.from(body["p_970b03"] as string, "base64");
    const d = createDecipheriv("aes-256-gcm", keyBytes, iv);
    d.setAuthTag(raw.subarray(raw.length - 16));
    const params = JSON.parse(
      Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8"),
    ) as Record<string, unknown>;
    expect(params["qualityTier"]).toBe("hd");
  });
});

describe("pickVideoUrl", () => {
  it("优先 video_fullinfo 中正常画质项", () => {
    expect(
      pickVideoUrl({
        url: "https://x/top.mp4",
        videos: [
          {
            url: "https://x/v.mp4",
            video_fullinfo: [
              { url: "https://x/hd.mp4", type: "高清" },
              { url: "https://x/std.mp4", type: "正常" },
            ],
          },
        ],
      }),
    ).toBe("https://x/std.mp4");
  });

  it("无分档信息时回退顶层 url", () => {
    expect(pickVideoUrl({ url: "https://x/top.mp4" })).toBe("https://x/top.mp4");
    expect(pickVideoUrl({})).toBe("");
  });
});

describe("XhsClient.resolveUrl", () => {
  it("非短链原样返回", async () => {
    const c = new XhsClient(vi.fn(async () => new Response("", { status: 200 })));
    const url = "https://www.xiaohongshu.com/explore/abc123";
    await expect(c.resolveUrl(url)).resolves.toBe(url);
  });

  it("短链跟随 Location", async () => {
    const full = "https://www.xiaohongshu.com/discovery/item/68f1a2b3000000001b02c3d4";
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("xhslink.com")) {
        return new Response(null, { status: 302, headers: { location: full } });
      }
      return new Response("", { status: 200 });
    });
    const c = new XhsClient(fetchFn as unknown as typeof fetch);
    await expect(c.resolveUrl("https://xhslink.com/abc")).resolves.toBe(full);
  });
});

describe("XhsClient.auth/parse（mock 网络）", () => {
  const DATA_ENC_B64 =
    "Ey0rHQIwNx0QPCIzFRsWaxgtMSJ3DCoqAiBvGWg+Fj4eAj0KYxwpHjEYdzw9Fj0jLBMXOG0fbjQ8NDUAEDQeMQUYGQkQKgIIHi0zFyAAOW1sOSgWMWgcbCB3OQMVLQAJMSsQHy8ZGBQ7AwlpNDgtAjkuAmI8NG5jOzQcaA0sGQs=";
  const IV_ENC_B64 = "CRVjEDwYAwBoNCAwHDgxDWdnLgUobBEt";

  function mockFetchForParse(parseData: unknown, parseStatus = 200) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u === "https://dy.kukutool.com/") {
        return new Response("ok", {
          status: 200,
          headers: { "set-cookie": "sess=abc; Path=/" },
        });
      }
      if (u.endsWith("/api/auth-970b03")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ k_970b03: "K", s_970b03: "S" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/api/parse")) {
        return new Response(JSON.stringify(parseData), {
          status: parseStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("parse 全链路打通（鉴权→解密→字段映射）", async () => {
    const fetchFn = mockFetchForParse({
      data: latin1(DATA_ENC_B64),
      iv: latin1(IV_ENC_B64),
    });
    const c = new XhsClient(fetchFn as unknown as typeof fetch);
    const r = await c.parse(
      "https://www.xiaohongshu.com/explore/68f1a2b3000000001b02c3d4",
    );
    expect(r.title).toBe("hello test");
    expect(r.downloadUrl).toBe("https://example.com/v.mp4");
    expect(r.cover).toBe("https://example.com/c.jpg");
    expect(r.noteId).toBe("68f1a2b3000000001b02c3d4");
  });

  it("图集无 url 报仅支持视频", async () => {
    const fetchFn = mockFetchForParse({ data: { pics: ["https://x/y.jpg"] }, iv: "e" });
    const c = new XhsClient(fetchFn as unknown as typeof fetch);
    await expect(c.parse("https://www.xiaohongshu.com/explore/abc")).rejects.toThrowError(
      /仅支持视频笔记/,
    );
  });

  it("对方改版：鉴权 500 透传原文", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const u = String(input);
      if (u === "https://dy.kukutool.com/") return new Response("ok", { status: 200 });
      return new Response("upstream changed v2", { status: 500 });
    });
    const c = new XhsClient(fetchFn as unknown as typeof fetch);
    await expect(
      c.parse("https://www.xiaohongshu.com/explore/abc"),
    ).rejects.toThrowError(/HTTP 500.*upstream changed v2/);
  });
});
