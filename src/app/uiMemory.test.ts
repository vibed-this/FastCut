import { describe, expect, it } from "vitest";
import { loadActiveCollectionId, loadOpenKeys } from "./uiMemory";

describe("loadOpenKeys", () => {
  it("无记录回 null（全部展开）", () => {
    expect(loadOpenKeys(() => null)).toBeNull();
  });
  it("合法数组原样返回，空数组合法", () => {
    expect(loadOpenKeys(() => '["南京","武汉"]')).toEqual(["南京", "武汉"]);
    expect(loadOpenKeys(() => "[]")).toEqual([]);
  });
  it("非法内容回 null，非字符串元素被过滤", () => {
    expect(loadOpenKeys(() => "not-json")).toBeNull();
    expect(loadOpenKeys(() => '{"a":1}')).toBeNull();
    expect(loadOpenKeys(() => '["南京",42,null]')).toEqual(["南京"]);
  });
  it("读取抛错回 null", () => {
    expect(
      loadOpenKeys(() => {
        throw new Error("denied");
      }),
    ).toBeNull();
  });
});

describe("loadActiveCollectionId", () => {
  it("无记录/空串回 null", () => {
    expect(loadActiveCollectionId(() => null)).toBeNull();
    expect(loadActiveCollectionId(() => "")).toBeNull();
    expect(loadActiveCollectionId(() => "  ")).toBeNull();
  });
  it("非空字符串原样返回", () => {
    expect(loadActiveCollectionId(() => "abc123")).toBe("abc123");
  });
  it("读取抛错回 null", () => {
    expect(
      loadActiveCollectionId(() => {
        throw new Error("denied");
      }),
    ).toBeNull();
  });
});
