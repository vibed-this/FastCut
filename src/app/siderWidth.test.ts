import { describe, expect, it } from "vitest";
import { DEFAULT_SIDER_WIDTH, MAX_SIDER_WIDTH, MIN_SIDER_WIDTH, clampSiderWidth, loadSiderWidth } from "./siderWidth";

describe("clampSiderWidth", () => {
  it("范围内原样返回（取整）", () => {
    expect(clampSiderWidth(300)).toBe(300);
    expect(clampSiderWidth(300.6)).toBe(301);
  });
  it("越界钳制到上下限", () => {
    expect(clampSiderWidth(50)).toBe(MIN_SIDER_WIDTH);
    expect(clampSiderWidth(2000)).toBe(MAX_SIDER_WIDTH);
  });
  it("非法输入回默认值", () => {
    expect(clampSiderWidth(Number.NaN)).toBe(DEFAULT_SIDER_WIDTH);
    expect(clampSiderWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDER_WIDTH);
  });
});

describe("loadSiderWidth", () => {
  it("无记录回默认值", () => {
    expect(loadSiderWidth(() => null)).toBe(DEFAULT_SIDER_WIDTH);
  });
  it("合法记录原样返回", () => {
    expect(loadSiderWidth(() => "350")).toBe(350);
  });
  it("非法记录回默认值或钳制", () => {
    expect(loadSiderWidth(() => "abc")).toBe(DEFAULT_SIDER_WIDTH);
    expect(loadSiderWidth(() => "")).toBe(MIN_SIDER_WIDTH);
    expect(loadSiderWidth(() => "9999")).toBe(MAX_SIDER_WIDTH);
  });
  it("读取抛错回默认值", () => {
    expect(
      loadSiderWidth(() => {
        throw new Error("denied");
      }),
    ).toBe(DEFAULT_SIDER_WIDTH);
  });
});
