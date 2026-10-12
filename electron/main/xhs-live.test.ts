/**
 * kukutool 解析链 live e2e（打真实网络，默认跳过）：
 * `KUKU_LIVE=1 npx vitest run electron/main/xhs-live.test.ts`
 * 用固定测试视频（高清）验证鉴权→parse→解密→直链可下载全链路。
 * 注意匿名额度每天 10 次，不要在 CI 跑。
 */
import { describe, expect, it } from "vitest";
import { XhsClient } from "./xhs-client.js";

const LIVE = process.env["KUKU_LIVE"] === "1";
const TEST_URL =
  "https://www.xiaohongshu.com/explore/6a9f05a1000000001203c08d?xsec_token=ABL0JkZHYoPCW3iwJdoCzme3k_hmj7dJxbY6qJpDCTwxk=&xsec_source=pc_search&source=web_search_result_notes";

describe.skipIf(!LIVE)("xhs live（KUKU_LIVE=1 才跑）", () => {
  it("测试视频解析出标题+可下载的高清直链", async () => {
    const c = new XhsClient();
    const r = await c.parse(TEST_URL, "hd");
    expect(r.title.trim()).not.toBe("");
    expect(r.noteId).toBe("6a9f05a1000000001203c08d");
    expect(r.downloadUrl).toMatch(/^https:\/\//);
    expect(r.cover).toMatch(/^https:\/\//);

    // 直链 HEAD：可下载、有体积、视频类型
    const head = await fetch(r.downloadUrl, { method: "HEAD", redirect: "follow" });
    expect(head.ok).toBe(true);
    const len = Number(head.headers.get("content-length") ?? "0");
    expect(len).toBeGreaterThan(100_000);
    expect(head.headers.get("content-type") ?? "").toMatch(/video|mp4|octet-stream/);
  }, 90_000);
});
