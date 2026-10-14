/** ImagePane 纯函数单测：缩略图提清晰度。 */
import { describe, expect, it } from "vitest";
import { upgradeThumbnailUrl } from "./ImagePane";

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
