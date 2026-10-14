/** ImagePane 纯函数单测：缩略图提清晰度、高清地址解析。 */
import { describe, expect, it } from "vitest";
import { resolveImageHdUrl, upgradeThumbnailUrl } from "./ImagePane";

describe("upgradeThumbnailUrl", () => {
  it("w_256 快照提为 w_1920 高清", () => {
    expect(upgradeThumbnailUrl("https://x/img?x-oss-process=image/resize,w_256/format,jpeg")).toContain(
      "w_1920",
    );
  });

  it("无 w_256 标记原样返回", () => {
    expect(upgradeThumbnailUrl("https://x/a.jpg")).toBe("https://x/a.jpg");
  });
});

describe("resolveImageHdUrl", () => {
  it("服务端 url 字段优先，fallback 为原缩略图", () => {
    const r = resolveImageHdUrl({ url: "https://x/hd.jpg?sig=1", thumbnail: "https://x/t?image/resize,w_256/a" });
    expect(r.primary).toBe("https://x/hd.jpg?sig=1");
    expect(r.fallback).toBe("https://x/t?image/resize,w_256/a");
  });

  it("无 url 时用提清晰度后的缩略图", () => {
    const r = resolveImageHdUrl({ thumbnail: "https://x/t?image/resize,w_256/a" });
    expect(r.primary).toContain("w_1920");
    expect(r.fallback).toBe("https://x/t?image/resize,w_256/a");
  });

  it("两者皆无时 primary 为空串", () => {
    expect(resolveImageHdUrl({}).primary).toBe("");
  });
});
