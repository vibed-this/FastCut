import { describe, expect, it } from "vitest";
import { toLocalMediaUrl } from "./media-url.js";

describe("toLocalMediaUrl", () => {
  it("空格编码、斜杠保留（旧行为兼容）", () => {
    expect(toLocalMediaUrl("/a b/c.jpg")).toBe("media://file/a%20b/c.jpg");
  });

  it("# 与 ? 按段编码，不被截断为 fragment", () => {
    expect(toLocalMediaUrl("/dir/标题 #话题 #v2.mp4")).toBe(
      "media://file/dir/%E6%A0%87%E9%A2%98%20%23%E8%AF%9D%E9%A2%98%20%23v2.mp4",
    );
    expect(toLocalMediaUrl("/dir/a?b.mp4")).toBe("media://file/dir/a%3Fb.mp4");
  });
});
