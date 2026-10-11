/** collections.ts 单测：短 id 与 slug 装配纯函数。 */
import { describe, expect, it } from "vitest";

import {
  buildXhsRelDir,
  buildXhsSlug,
  newXhsId,
  randomShortId,
  shortFromXhsId,
  XHS_ID_PREFIX,
  XHS_ROOT,
} from "./collections.js";

describe("randomShortId", () => {
  it("8 位十六进制且每次不同", () => {
    const a = randomShortId();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(randomShortId()).not.toBe(a);
  });
});

describe("newXhsId / shortFromXhsId", () => {
  it("前缀装配与解析往返", () => {
    const id = newXhsId("abcdef12");
    expect(id).toBe(`${XHS_ID_PREFIX}abcdef12`);
    expect(shortFromXhsId(id)).toBe("abcdef12");
  });

  it("非 xhs id 返回 null", () => {
    expect(shortFromXhsId("wDtnwT8ErHW")).toBeNull();
    expect(shortFromXhsId(`${XHS_ID_PREFIX}  `)).toBeNull();
  });
});

describe("buildXhsSlug / buildXhsRelDir", () => {
  it("slug 为清洗名 + 短 id", () => {
    expect(buildXhsSlug("旅行", "abcdef12")).toBe("旅行-abcdef12");
    expect(buildXhsRelDir("旅行", "abcdef12")).toBe(`${XHS_ROOT}/旅行-abcdef12`);
  });

  it("非法字符被清洗", () => {
    expect(buildXhsSlug("a/b\\c", "abcdef12")).toBe("abc-abcdef12");
  });
});
