/** share-link.ts 单测：纯函数，无环境依赖。 */
import { describe, expect, it } from "vitest";

import { detectShareLink, extractPwd } from "./share-link.js";

describe("detectShareLink", () => {
  it("alipan 分享链接", () => {
    expect(detectShareLink("https://www.alipan.com/s/abc123")).toEqual({
      kind: "alipan",
      url: "https://www.alipan.com/s/abc123",
    });
  });

  it("alipan 子域名 + 路径后缀 + 查询串", () => {
    expect(
      detectShareLink("去看看 https://test.aliyundrive.com/s/xyz/folder?a=1 。"),
    ).toEqual({ kind: "alipan", url: "https://test.aliyundrive.com/s/xyz/folder?a=1" });
  });

  it("括号包裹与中文句号被清掉", () => {
    expect(detectShareLink("（https://www.alipan.com/s/abc123）。")).toEqual({
      kind: "alipan",
      url: "https://www.alipan.com/s/abc123",
    });
  });

  it("非 /s/ 路径不算分享", () => {
    expect(detectShareLink("https://www.alipan.com/drive")).toBeNull();
    expect(detectShareLink("https://www.alipan.com/s/")).toBeNull();
  });

  it("提取码一并带回", () => {
    expect(
      detectShareLink("https://www.alipan.com/s/abc123 提取码：qwer"),
    ).toEqual({ kind: "alipan", url: "https://www.alipan.com/s/abc123", pwd: "qwer" });
  });

  it("小红书链接（www 与短链）", () => {
    expect(detectShareLink("https://www.xiaohongshu.com/explore/abc?x=1")).toEqual({
      kind: "xiaohongshu",
      url: "https://www.xiaohongshu.com/explore/abc?x=1",
    });
    expect(detectShareLink("http://xhslink.com/a/b")).toEqual({
      kind: "xiaohongshu",
      url: "http://xhslink.com/a/b",
    });
  });

  it("两种都有取先出现的", () => {
    expect(
      detectShareLink("https://www.xiaohongshu.com/explore/a 和 https://www.alipan.com/s/b"),
    )?.toMatchObject({ kind: "xiaohongshu" });
    expect(
      detectShareLink("https://www.alipan.com/s/b 和 https://www.xiaohongshu.com/explore/a"),
    )?.toMatchObject({ kind: "alipan" });
  });

  it("无链接/空文本返回 null", () => {
    expect(detectShareLink("今天天气不错")).toBeNull();
    expect(detectShareLink("   ")).toBeNull();
    expect(detectShareLink("https://example.com/a")).toBeNull();
  });
});

describe("extractPwd", () => {
  it("多种写法", () => {
    expect(extractPwd("提取码: ab12")).toBe("ab12");
    expect(extractPwd("密码：AB12")).toBe("AB12");
    expect(extractPwd("pwd=9z8x")).toBe("9z8x");
    expect(extractPwd("没有码")).toBeUndefined();
  });
});
