/**
 * Electron 全链走查（Wave 5）。
 *
 * 对照旧 Tauri 版 `e2e/reference/walkthrough-tauri-assertions.js` 的断言逐条翻译，
 * 不运行旧文件，只复用它的步骤与选择器语义。
 */
import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtempSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

const SHARE_URL = "https://www.alipan.com/s/wDtnwT8ErHW";
const SHARE_TITLE_PART = "红星日常素材";
const WANT_VIDEO = "DJI_20240809_163130_308_video.mp4";
const SHOTS = resolve(HERE, "../shots");
const EXECUTABLE = resolve(
  HERE,
  "../../dist/mac-arm64/FastCut.app/Contents/MacOS/FastCut",
);

let app: ElectronApplication;
let win: Page;
let userDataDir: string;
let targetDir: string;
const ctx: {
  shareId: string;
  folderId: string;
  folderName: string;
  fileId: string;
  fileName: string;
  smallFileId: string;
  smallFileName: string;
  savedPath: string;
  savedFileId: string;
} = {
  shareId: "",
  folderId: "",
  folderName: "",
  fileId: "",
  fileName: "",
  smallFileId: "",
  smallFileName: "",
  savedPath: "",
  savedFileId: "",
};

/** renderer 侧 bridge 的最小形状（绕开 renderer 源码类型）。 */
type Bridge = {
  invoke: (channel: string, args?: unknown) => Promise<never>;
  onDownloadDone: (handler: (payload: { file_id: string; ok: boolean; path?: string }) => void) => () => void;
  onDownloadProgress: (
    handler: (payload: { file_id: string; done: number; total: number }) => void,
  ) => () => void;
};

function bridgeInvoke<T>(page: Page, channel: string, args?: unknown): Promise<T> {
  return page.evaluate(
    ({ c, a }) => (window as unknown as { fastcut: Bridge }).fastcut.invoke(c, a) as Promise<never>,
    { c: channel, a: args },
  ) as Promise<T>;
}

interface ShareRow {
  share_id: string;
  name: string;
  url: string;
}
interface ListItem {
  file_id: string;
  drive_id: string;
  name: string;
  type: string;
  size?: number;
}
interface ListRes {
  items: ListItem[];
  next_marker: string;
}

/** 带退避的 list_share（站方限流 BlockException/TooManyRequests 时重试一次）。 */
async function listShareRetry(page: Page, args: unknown): Promise<ListRes> {
  try {
    return await bridgeInvoke<ListRes>(page, "list_share", args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("TooManyRequests") || msg.includes("BlockException")) {
      await page.waitForTimeout(6000);
      return await bridgeInvoke<ListRes>(page, "list_share", args);
    }
    throw e;
  }
}

/** 经 IPC 找到分享/目录/目标视频的 id（不依赖 React 内部 state）。 */
async function discoverIds(
  page: Page,
  wantVideo: string,
): Promise<{
  shareId: string;
  folderId: string;
  folderName: string;
  fileId: string;
  fileName: string;
  smallFileId: string;
  smallFileName: string;
}> {
  const shares = await bridgeInvoke<ShareRow[]>(page, "list_shares", {});
  const share = shares.find((s) => s.name.includes(SHARE_TITLE_PART));
  if (!share) throw new Error("IPC 侧找不到分享");
  const root = await listShareRetry(page, {
    shareId: share.share_id,
    parentFileId: "root",
  });
  const folders = root.items.filter((i) => i.type === "folder");
  if (folders.length === 0) throw new Error("根目录下无文件夹");
  // 逐个文件夹找目标视频，找不到则回退到任一 mp4；同时记录同目录最小 mp4（给下载用例，快且稳）
  let fallback: { folder: ListItem; file: ListItem } | null = null;
  let small: { folder: ListItem; file: ListItem } | null = null;
  for (const folder of folders) {
    await page.waitForTimeout(1500);
    const sub = await listShareRetry(page, {
      shareId: share.share_id,
      parentFileId: folder.file_id,
    });
    const mp4s = sub.items.filter((i) => i.name.toLowerCase().endsWith(".mp4"));
    for (const m of mp4s) {
      if (!small || (m.size ?? Number.MAX_SAFE_INTEGER) < (small.file.size ?? Number.MAX_SAFE_INTEGER)) {
        small = { folder, file: m };
      }
    }
    const hit = sub.items.find((i) => i.name === wantVideo);
    if (hit) {
      const s = small ?? { folder, file: hit };
      return {
        shareId: share.share_id,
        folderId: folder.file_id,
        folderName: folder.name,
        fileId: hit.file_id,
        fileName: hit.name,
        smallFileId: s.file.file_id,
        smallFileName: s.file.name,
      };
    }
    const anyMp4 = mp4s[0];
    if (anyMp4 && !fallback) fallback = { folder, file: anyMp4 };
  }
  if (fallback) {
    const s = small ?? fallback;
    return {
      shareId: share.share_id,
      folderId: fallback.folder.file_id,
      folderName: fallback.folder.name,
      fileId: fallback.file.file_id,
      fileName: fallback.file.name,
      smallFileId: s.file.file_id,
      smallFileName: s.file.name,
    };
  }
  throw new Error("所有子目录均无 mp4");
}

/** UI 上打开分享并进入指定文件夹（幂等：tab 已存在则直接点）。 */
async function uiOpenShareAndFolder(page: Page, folderName: string): Promise<void> {
  const item = page.locator('[data-testid="share-item"]', { hasText: SHARE_TITLE_PART }).first();
  await expect(item).toBeVisible({ timeout: 60_000 });
  await item.click();
  await expect(page.locator('[data-testid="tab-title"]').first()).toBeVisible({ timeout: 60_000 });
  // 根目录应为文件夹磁贴；点击与 IPC 发现同名的那个
  const folders = page.locator('[data-testid="enter-folder"]');
  await expect(folders.first()).toBeVisible({ timeout: 60_000 });
  const n = await folders.count();
  let clicked = false;
  for (let i = 0; i < n; i++) {
    const text = (await folders.nth(i).innerText().catch(() => "")) ?? "";
    if (text.includes(folderName)) {
      await folders.nth(i).click();
      clicked = true;
      break;
    }
  }
  if (!clicked) await folders.first().click();
  await expect(page.locator('[data-testid="preview-file"]').first()).toBeVisible({ timeout: 90_000 });
}

/** 把“加载更多”点到底（最多 12 页，防止异常循环）。 */
async function uiLoadAll(page: Page): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const more = page.locator('[data-testid="load-more"]');
    if ((await more.count()) === 0) return;
    if (!(await more.first().isVisible().catch(() => false))) return;
    await more.first().click();
    await page.waitForTimeout(2500);
  }
}

/** 双击打开指定文件名的视频（单击仅选中，完整播放器需双击）。 */
async function uiPreviewFile(page: Page, fileName: string): Promise<void> {
  const tiles = page.locator('[data-testid="preview-file"]');
  await expect(tiles.first()).toBeVisible({ timeout: 90_000 });
  const n = await tiles.count();
  for (let i = 0; i < n; i++) {
    const text = (await tiles.nth(i).innerText().catch(() => "")) ?? "";
    if (text.includes(fileName)) {
      await tiles.nth(i).click();
      await tiles.nth(i).dblclick();
      return;
    }
  }
  // 回退：文件名含 mp4 的第一个
  for (let i = 0; i < n; i++) {
    const text = (await tiles.nth(i).innerText().catch(() => "")) ?? "";
    if (text.toLowerCase().includes(".mp4")) {
      await tiles.nth(i).click();
      await tiles.nth(i).dblclick();
      return;
    }
  }
  await tiles.first().click();
  await tiles.first().dblclick();
}

/** 若文件/文件夹磁贴都不存在（如瞬时限流导致列表为空），reload 后重进目录自愈。 */
async function ensureInFolder(page: Page, folderName: string): Promise<void> {
  const tiles = await page.locator('[data-testid="preview-file"], [data-testid="enter-folder"]').count();
  if (tiles > 0) return;
  await page.reload();
  await expect(page.locator('[data-testid="add-share-btn"]')).toBeVisible({ timeout: 60_000 });
  await uiOpenShareAndFolder(page, folderName);
}

/** 用应用自带的“重取链接”恢复瞬时过期（限流/签名抖动），最多 rounds 轮；返回当前是否仍过期。 */
async function ensurePreviewClean(page: Page, rounds = 2): Promise<boolean> {
  for (let i = 0; i <= rounds; i++) {
    const text = (await page.evaluate(() => document.body.innerText)) ?? "";
    if (!text.includes("链接过期请重试") && !text.includes("EXPIRED")) return false;
    const retryBtn = page.getByRole("button", { name: "重取链接" });
    if ((await retryBtn.count()) === 0) return true;
    await retryBtn.first().click();
    await page.waitForTimeout(10_000);
  }
  const text = (await page.evaluate(() => document.body.innerText)) ?? "";
  return text.includes("链接过期请重试") || text.includes("EXPIRED");
}

function findMp4Recursive(dir: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase().endsWith(".mp4")) return p;
    if (e.isDirectory()) {
      const hit = findMp4Recursive(p);
      if (hit) return hit;
    }
  }
  return null;
}

// 同一文件内的用例按声明顺序串行执行（单 worker）；不使用 serial 模式，
// 以免 c（已知应用 bug 导致失败）阻断 d/e/f 的独立验证。

test.beforeAll(async () => {
  if (!existsSync(EXECUTABLE)) {
    throw new Error(`找不到打包产物可执行文件：${EXECUTABLE}（先确认 dist/mac-arm64/FastCut.app 存在）`);
  }
  userDataDir = mkdtempSync(join(tmpdir(), "fastcut-e2e-user-"));
  targetDir = mkdtempSync(join(tmpdir(), "fastcut-e2e-target-"));
  app = await electron.launch({
    executablePath: EXECUTABLE,
    args: [`--user-data-dir=${userDataDir}`],
  });
  win = await app.firstWindow();
  await win.setViewportSize({ width: 1440, height: 900 });
  await expect(win.locator('[data-testid="add-share-btn"]')).toBeVisible({ timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
});

test("a. 加分享：侧栏出现红星日常素材", async () => {
  const existing = await win.locator('[data-testid="share-item"]').count();
  if (existing === 0) {
    await win.locator('[data-testid="add-share-btn"]').click();
    await win.locator('[data-testid="share-url-input"]').fill(SHARE_URL);
    await win.locator('[data-testid="add-share-confirm"]').click();
  }
  const item = win.locator('[data-testid="share-item"]', { hasText: SHARE_TITLE_PART }).first();
  await expect(item).toBeVisible({ timeout: 90_000 });
  await win.screenshot({ path: join(SHOTS, "01-share-added.png") });
});

test("b. 进目录：文件列表出现 mp4，翻页到底", async () => {
  const found = await discoverIds(win, WANT_VIDEO);
  ctx.shareId = found.shareId;
  ctx.folderId = found.folderId;
  ctx.folderName = found.folderName;
  ctx.fileId = found.fileId;
  ctx.fileName = found.fileName;
  ctx.smallFileId = found.smallFileId;
  ctx.smallFileName = found.smallFileName;
  await uiOpenShareAndFolder(win, ctx.folderName);
  await uiLoadAll(win);
  const mp4Tile = win.locator('[data-testid="preview-file"]').filter({ hasText: ".mp4" }).first();
  await expect(mp4Tile).toBeVisible({ timeout: 60_000 });
  await win.screenshot({ path: join(SHOTS, "02-list.png") });
});

test("c. 预览：readyState>=2 且无过期告警", async () => {
  await ensureInFolder(win, ctx.folderName);
  await uiPreviewFile(win, ctx.fileName);
  const video = win.locator('[data-testid="preview-video"]');
  await expect(video).toBeVisible({ timeout: 120_000 });
  // 先确认取链路健康：等待转码档出现且 15s 内无过期告警（该段应通过）
  await expect(win.locator(".xgplayer").first()).toBeVisible({ timeout: 60_000 });
  await win.waitForTimeout(10_000);
  // 瞬时过期走应用自带“重取链接”恢复一轮，再断言
  if (await ensurePreviewClean(win)) {
    const t = (await win.evaluate(() => document.body.innerText)) ?? "";
    expect(t).not.toContain("链接过期请重试");
    expect(t).not.toContain("EXPIRED");
  }
  // 先截一张（readyState 等待若超时失败，此图仍保留现场供肉眼确认）
  await win.screenshot({ path: join(SHOTS, "03-preview.png") });
  // 触发一次播放以加速首帧缓冲（自动播放策略下 catch 忽略；
  // xgplayer 在容器内渲染自己的 <video>，查询容器内的 video 元素）
  await win.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="preview-video"] video');
    if (v) {
      v.muted = true;
      void v.play().catch(() => undefined);
    }
  });
  // 注：曾有 player effect 只依赖 [playUrl] 导致 loading 期重挂载后 src 永不设置的
  // 黑屏 bug（Card loading 会卸载 <video>），已修复：effect 依赖改为 [playUrl, loading]。
  // 现切换为 xgplayer：容器 div 保留 data-testid="preview-video"，真实 <video> 在其内部，
  // 以下断言验证修复：容器内 video 的 readyState 必须达到 >= 2。
  await win.waitForFunction(
    () => {
      const v = document.querySelector<HTMLVideoElement>('[data-testid="preview-video"] video');
      return v !== null && v.readyState >= 2;
    },
    undefined,
    { timeout: 90_000, polling: 1000 },
  );
  const bodyText = (await win.evaluate(() => document.body.innerText)) ?? "";
  expect(bodyText).not.toContain("链接过期请重试");
  expect(bodyText).not.toContain("EXPIRED");
  await win.waitForTimeout(1500);
  await win.screenshot({ path: join(SHOTS, "03-preview.png") });
});

test("f. 样式验收：antd 主按钮为蓝色且浅色 UI 正常", async () => {
  // antd v6 主色 #1677ff；CSS 生效是“无抽取/无裸奔”的直接证据
  const bg = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="add-share-btn"]');
    if (!el) return "missing";
    return getComputedStyle(el).backgroundColor;
  });
  expect(bg).toBe("rgb(22, 119, 255)");
  const linkCount = await win.evaluate(
    () => document.querySelectorAll('link[rel="stylesheet"]').length,
  );
  const styleTagCount = await win.evaluate(() => document.querySelectorAll("style").length);
  expect(styleTagCount + linkCount).toBeGreaterThan(0);
});

test("d. 设目标目录并保存：download-done ok 且 mp4 可播放", async () => {
  // 经 IPC 写目标目录（原生选框在回归中无法交互），reload 让侧栏读到新配置。
  // 下载用同目录最小 mp4（与预览_tpl_链路相同，下载更快更稳）；去重断言以该文件为准。
  await bridgeInvoke(win, "set_config", { config: { target_dir: targetDir } });
  const cfg = await bridgeInvoke<{ target_dir?: string }>(win, "get_config", {});
  expect(cfg.target_dir).toBe(targetDir);
  await win.reload();
  await expect(win.locator('[data-testid="add-share-btn"]')).toBeVisible({ timeout: 60_000 });
  await uiOpenShareAndFolder(win, ctx.folderName);
  await uiLoadAll(win);
  await uiPreviewFile(win, ctx.smallFileName);
  await expect(win.locator('[data-testid="preview-video"]')).toBeVisible({ timeout: 120_000 });
  await expect(win.locator(".xgplayer").first()).toBeVisible({ timeout: 60_000 });
  await win.waitForTimeout(8000);
  // 瞬时过期走应用自带“重取链接”恢复；仍过期则如实失败（取链路问题）
  expect(await ensurePreviewClean(win)).toBe(false);
  ctx.savedFileId = ctx.smallFileId;

  // 先订阅 download-done，再点保存
  await win.evaluate(() => {
    (window as unknown as { __done?: unknown }).__done = null;
    (window as unknown as { fastcut: Bridge }).fastcut.onDownloadDone((d) => {
      (window as unknown as { __done?: unknown }).__done = d;
    });
  });
  const saveBtn = win.locator('[data-testid="save-video"]');
  await expect(saveBtn).toBeEnabled({ timeout: 90_000 });
  await saveBtn.click();
  // 若播放地址未就绪（取链路失败），8s 内出现警告则快速失败，不空等 170s
  await win.waitForTimeout(8000);
  const warnText = (await win.evaluate(() => document.body.innerText)) ?? "";
  expect(warnText.includes("播放地址尚未就绪")).toBe(false);
  await win.waitForFunction(
    () => (window as unknown as { __done?: unknown }).__done !== null,
    undefined,
    { timeout: 160_000, polling: 2000 },
  );
  const done = (await win.evaluate(
    () => (window as unknown as { __done?: { file_id: string; ok: boolean; path?: string } }).__done,
  )) as { file_id: string; ok: boolean; path?: string; error?: string };
  expect(done.ok).toBe(true);

  let savedPath = done.path ?? "";
  if (!savedPath || !existsSync(savedPath)) {
    const hit = findMp4Recursive(targetDir);
    if (hit) savedPath = hit;
  }
  expect(savedPath !== "").toBe(true);
  expect(existsSync(savedPath)).toBe(true);
  expect(statSync(savedPath).size).toBeGreaterThan(10_000);
  ctx.savedPath = savedPath;
  const probe = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", savedPath],
    { encoding: "utf8" },
  ).trim();
  expect(Number(probe)).toBeGreaterThan(0);
  await win.screenshot({ path: join(SHOTS, "04-saved.png") });
});

test("d2. 播即存：完整模式按播放自动触发下载（不等完成）", async () => {
  // d 用例停在小文件播放器里：先关掉，切大文件验证“一点播放就存”，全程不点保存按钮。
  await win.keyboard.press("Escape");
  await expect(win.locator('[data-testid="video-player-modal"]')).toBeHidden({ timeout: 30_000 });
  await uiPreviewFile(win, ctx.fileName);
  await expect(win.locator('[data-testid="preview-video"]')).toBeVisible({ timeout: 120_000 });
  await expect(win.locator(".xgplayer").first()).toBeVisible({ timeout: 60_000 });
  await win.evaluate(() => {
    (window as unknown as { __prog?: unknown }).__prog = null;
    (window as unknown as { fastcut: Bridge }).fastcut.onDownloadProgress((p) => {
      (window as unknown as { __prog?: unknown }).__prog = p;
    });
  });
  // 空格=播放（open 模式 toggle），播即存只认第一次 play
  await win.keyboard.press("Space");
  await win.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="preview-video"] video') as HTMLVideoElement | null;
      return v !== null && !v.paused;
    },
    undefined,
    { timeout: 60_000, polling: 1000 },
  );
  // “已开始下载”提示出现（antd v6 notice 选择器），且主进程开始吐进度
  await expect(win.locator(".ant-message-notice", { hasText: "已开始下载" }).first()).toBeVisible({
    timeout: 120_000,
  });
  await win.waitForFunction(
    () => (window as unknown as { __prog?: unknown }).__prog !== null,
    undefined,
    { timeout: 120_000, polling: 2000 },
  );
  const prog = (await win.evaluate(
    () => (window as unknown as { __prog?: { file_id: string; done: number; total: number } }).__prog,
  )) as { file_id: string; done: number; total: number };
  expect(prog.file_id).toBe(ctx.fileId);
  expect(prog.total).toBeGreaterThan(0);
  // 关窗让后台下完与否都不阻塞后续用例（fire-and-forget）
  await win.keyboard.press("Escape");
  await win.screenshot({ path: join(SHOTS, "04b-auto-save.png") });
});

test("e. 去重记账：同一文件状态为 saved", async () => {
  const statuses = await bridgeInvoke<{ file_id: string; state: string }[]>(win, "get_status_batch", {
    shareId: ctx.shareId,
    fileIds: [ctx.savedFileId],
  });
  const st = statuses.find((s) => s.file_id === ctx.savedFileId);
  expect(st?.state).toBe("saved");
  // UI 角标同步出现“已保存”（FolderView 在 progressClear 后重查状态）
  await expect(win.getByText("已保存").first()).toBeVisible({ timeout: 60_000 });
  await win.screenshot({ path: join(SHOTS, "05-dedup.png") });
});
