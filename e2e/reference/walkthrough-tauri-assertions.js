/**
 * 主流程走查：空态 → 加分享 → 开标签 → 进目录 → 视频预览，每步截图。
 * 幂等：分享已存在则直接打开，不重复添加。
 */
import path from "path";
import { fileURLToPath } from "url";

const SHARE_URL = "https://www.alipan.com/s/wDtnwT8ErHW";
const SHARE_TITLE = "红星日常素材";
const shotsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "shots");

/** 等待至少一个匹配元素出现（$ 在多匹配下会 strict 违规，只能用 $$ 轮询）。 */
async function waitAny(selector, timeout = 180000) {
  await browser.waitUntil(async () => (await $$(selector)).length > 0, {
    timeout,
    timeoutMsg: `等不到元素 ${selector}`,
  });
  return $$(selector);
}

describe("FastCut 文件管理器走查", () => {
  it("首屏空态渲染正常", async () => {
    await browser.setWindowSize(1440, 900);
    await $('[data-testid="add-share-btn"]').waitForDisplayed();
    await browser.saveScreenshot(path.join(shotsDir, "01-empty.png"));
  });

  it("添加分享（已存在则跳过）", async () => {
    const existing = await $$('[data-testid="share-item"]');
    if (existing.length === 0) {
      await $('[data-testid="add-share-btn"]').click();
      const urlInput = await $('[data-testid="share-url-input"]');
      await urlInput.waitForDisplayed();
      await urlInput.setValue(SHARE_URL);
      await $('[data-testid="add-share-confirm"]').click();
      await waitAny('[data-testid="share-item"]', 60000);
    }
    await browser.saveScreenshot(path.join(shotsDir, "02-share-added.png"));
  });

  it("打开分享标签并展示根目录", async () => {
    const items = await waitAny('[data-testid="share-item"]');
    expect(items.length).toBeGreaterThan(0);
    await items[0].click();
    await waitAny('[data-testid="tab-title"]');
    await waitAny('[data-testid="enter-folder"]');
    await browser.saveScreenshot(path.join(shotsDir, "03-root.png"));
  });

  it("进入子目录再返回", async () => {
    const enterBtns = await waitAny('[data-testid="enter-folder"]');
    await enterBtns[0].click();
    await browser.pause(4000);
    await browser.saveScreenshot(path.join(shotsDir, "04-subfolder.png"));
    // 面包屑返回根目录
    const crumbs = await $$(".ant-breadcrumb a");
    if (crumbs.length > 0) {
      await crumbs[0].click();
      await waitAny('[data-testid="enter-folder"]');
    }
  });

  it("选中视频弹出预览窗格", async () => {
    const previewBtns = await waitAny('[data-testid="preview-file"]');
    await previewBtns[0].click();
    await $('[data-testid="preview-video"]').waitForExist({ timeout: 120000 });
    // 等 hls 取到首段：readyState>=2 或 90s 内无过期告警
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const v = document.querySelector('[data-testid="preview-video"]');
          const ok = v !== null && v.readyState >= 2;
          const bad = document.body.innerText.includes("链接过期请重试");
          return ok || bad;
        }),
      {
        timeout: 90000,
        timeoutMsg: "视频 90s 内未加载出首帧",
      },
    );
    const expired = await browser.execute(() =>
      document.body.innerText.includes("链接过期请重试"),
    );
    expect(expired).toBe(false);
    await browser.saveScreenshot(path.join(shotsDir, "05-preview.png"));
  });
});
