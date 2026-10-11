/**
 * 记忆恢复专项走查（restore-memory）。
 *
 * 背景：右侧打开合集的记忆曾因“挂载瞬间 persist effect 用初始 null 清掉存储”
 * 而从未生效；叠加站方瞬时限流（BlockException/rule:TooManyRequests）导致
 * 打开即红错。本文件只验证这两处修复，不跑完整业务走查：
 * 1. 分类折叠 + 右侧打开（xiaohongshu 本地合集，零网络）在 reload 后恢复；
 * 2. 删除合集后记忆清除；
 * 3. 真实网络 list_share 一次（验证主进程限流重试谓词；持续限流则如实失败）。
 */
import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXECUTABLE = resolve(HERE, "../../dist/mac-arm64/FastCut.app/Contents/MacOS/FastCut");

const CAT = "e2e记忆类";
const NAME_A = "e2e记忆甲";
const NAME_B = "e2e记忆乙";

let app: ElectronApplication;
let win: Page;
let userDataDir: string;
let targetDir: string;
/** 测试 1 建好的合集 A id，测试 2 用它断言“恢复的是同一个”。 */
let idA = "";

type Bridge = {
  invoke: (channel: string, args?: unknown) => Promise<never>;
};

function bridgeInvoke<T>(page: Page, channel: string, args?: unknown): Promise<T> {
  return page.evaluate(
    ({ c, a }) => (window as unknown as { fastcut: Bridge }).fastcut.invoke(c, a) as Promise<never>,
    { c: channel, a: args },
  ) as Promise<T>;
}

interface AddedCollection {
  collection_id?: string;
  id?: string;
  name: string;
}

test.beforeAll(async () => {
  if (!existsSync(EXECUTABLE)) {
    throw new Error(`找不到打包产物可执行文件：${EXECUTABLE}`);
  }
  userDataDir = mkdtempSync(join(tmpdir(), "fastcut-e2e-mem-user-"));
  targetDir = mkdtempSync(join(tmpdir(), "fastcut-e2e-mem-target-"));
  app = await electron.launch({
    executablePath: EXECUTABLE,
    args: [`--user-data-dir=${userDataDir}`],
  });
  win = await app.firstWindow();
  await win.setViewportSize({ width: 1280, height: 800 });
  await expect(win.locator('[data-testid="add-collection-btn"]')).toBeVisible({ timeout: 60_000 });
  // xhs 合集落盘到 target_dir：先配好，再播种（全本地，无网络）。
  await bridgeInvoke(win, "set_config", { config: { target_dir: targetDir } });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
});

test("1. 播种两个本地合集并打开其中一个、折叠其分类", async () => {
  const a = await bridgeInvoke<AddedCollection>(win, "collection_add", {
    kind: "xiaohongshu",
    name: NAME_A,
    category: CAT,
  });
  await bridgeInvoke(win, "collection_add", { kind: "xiaohongshu", name: NAME_B, category: CAT });
  idA = a.collection_id ?? a.id ?? "";
  expect(idA).not.toBe("");
  // IPC 播种绕过渲染层 store：reload 让侧边栏加载新列表（与真实启动一致）。
  await win.reload();
  await expect(win.locator('[data-testid="add-collection-btn"]')).toBeVisible({ timeout: 60_000 });

  // 点开 A：右侧出现面包屑。注意面包屑只显示栈路径（含“合集根目录”），不含合集名；
  // “打开的是哪一个”以 localStorage 的 activeCollectionId 为准。
  await win.locator('[data-testid="collection-item"]', { hasText: NAME_A }).first().click();
  await expect(win.locator('[data-testid="explorer-breadcrumb"]').first()).toBeVisible({
    timeout: 30_000,
  });

  // 折叠 A 所在分类：A 行消失，B 行（同类）也消失。
  await win.locator('[data-testid="collection-category-header"]', { hasText: CAT }).first().click();
  await expect(
    win.locator('[data-testid="collection-item"]', { hasText: NAME_A }).first(),
  ).toBeHidden({ timeout: 10_000 });

  // 记忆已落盘：打开 id 与折叠 keys。
  const storedId = await win.evaluate(() => localStorage.getItem("fastcut.activeCollectionId"));
  const storedKeys = await win.evaluate(() => localStorage.getItem("fastcut.openKeys"));
  expect(storedId).toBe(idA);
  expect(storedKeys === null || !storedKeys.includes(CAT)).toBe(true);
});

test("2. reload 后折叠与打开同时恢复", async () => {
  await win.reload();
  await expect(win.locator('[data-testid="add-collection-btn"]')).toBeVisible({ timeout: 60_000 });
  // 右侧自动回到上次打开的合集（根目录）：面包屑可见，且记忆的 id 与 A 一致。
  await expect(win.locator('[data-testid="explorer-breadcrumb"]').first()).toBeVisible({
    timeout: 30_000,
  });
  expect(await win.evaluate(() => localStorage.getItem("fastcut.activeCollectionId"))).toBe(idA);
  await expect(
    win.locator('[data-testid="collection-item"]', { hasText: NAME_A }).first(),
  ).toBeHidden({ timeout: 10_000 });
  await expect(
    win.locator('[data-testid="collection-item"]', { hasText: NAME_B }).first(),
  ).toBeHidden({ timeout: 10_000 });
});

test("3. 删除已打开合集后记忆清除、不再恢复", async () => {
  // 先展开分类才能点到行（用表头切回展开）。
  await win.locator('[data-testid="collection-category-header"]', { hasText: CAT }).first().click();
  const row = win.locator('[data-testid="collection-item"]', { hasText: NAME_A }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  const storedId = await win.evaluate(() => localStorage.getItem("fastcut.activeCollectionId"));
  expect(storedId).toBe(idA);
  // 走真实 UI 删除（更多菜单 → 删除 → 二次确认），渲染层 store 才会被通知。
  const item = win
    .locator("li", { has: win.locator('[data-testid="collection-item"]', { hasText: NAME_A }) })
    .first();
  await item.hover();
  await item.getByRole("button", { name: "更多操作" }).click();
  await win.getByRole("menuitem", { name: "删除" }).click();
  await win.locator(".ant-modal-confirm-btns").getByRole("button", { name: "删除" }).click();
  await expect(win.locator('[data-testid="explorer-breadcrumb"]').first()).toBeHidden({
    timeout: 10_000,
  });
  expect(await win.evaluate(() => localStorage.getItem("fastcut.activeCollectionId"))).toBeNull();
  await win.reload();
  await expect(win.locator('[data-testid="add-collection-btn"]')).toBeVisible({ timeout: 60_000 });
  // 右侧保持空状态，不会复活已删合集。
  await expect(win.locator('[data-testid="explorer-breadcrumb"]').first()).toBeHidden({
    timeout: 10_000,
  });
});

test("4. 真实网络 list_share（限流重试验证）", async () => {
  // 直接打已知分享根目录：主进程对 BlockException/rule:TooManyRequests 应退避重试。
  // 若站方持续限流，本用例如实失败并打印原文，不吞错。
  const res = await bridgeInvoke<{ items: unknown[]; next_marker: string }>(win, "list_share", {
    shareId: "wDtnwT8ErHW",
    parentFileId: "root",
  });
  expect(Array.isArray(res.items)).toBe(true);
  expect(res.items.length).toBeGreaterThan(0);
});
