/**
 * store.ts 的 vitest 测试：URL 解析、配置落盘、合集增删改、
 * 小红书合集磁盘联动、落盘 roundtrip 与旧数据迁移。
 * 全部以临时目录充当 userDataDir。
 */
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addCollection,
  extractShareId,
  getConfig,
  getIsDownloadingProvider,
  getOrderedCategories,
  getOrderedCollections,
  getSidebarOrders,
  getStatus,
  getStatusBatch,
  ledgerKey,
  legacyStorePath,
  listCollections,
  normalizeCategory,
  normalizeCategoryKey,
  normalizeDefinition,
  nowSecs,
  parseShareUrl,
  recordLedger,
  removeCollection,
  renameCollection,
  reorderCategories,
  reorderCollections,
  setCollectionCategory,
  setConfig,
  setIsDownloadingProvider,
  STORE_FILE,
} from "./store.js";

let dir = "";
let emptyHome = "";
let savedHome: string | undefined;
let savedAppData: string | undefined;
let savedXdg: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastcut-store-test-"));
  // 默认把 HOME 指向空目录，避免测到本机真实旧数据（迁移测试会自行覆盖 HOME）
  emptyHome = await mkdtemp(join(tmpdir(), "fastcut-store-emptyhome-"));
  savedHome = process.env["HOME"];
  savedAppData = process.env["APPDATA"];
  savedXdg = process.env["XDG_DATA_HOME"];
  process.env["HOME"] = emptyHome;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  if (savedAppData === undefined) delete process.env["APPDATA"];
  else process.env["APPDATA"] = savedAppData;
  if (savedXdg === undefined) delete process.env["XDG_DATA_HOME"];
  else process.env["XDG_DATA_HOME"] = savedXdg;
  setIsDownloadingProvider(() => false);
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
  await rm(emptyHome, { recursive: true, force: true });
});

function storeFile(): string {
  return join(dir, STORE_FILE);
}

async function readRaw(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(storeFile(), "utf8")) as Record<string, unknown>;
}

describe("ledgerKey", () => {
  it("格式为 shareId:fileId", () => {
    expect(ledgerKey("s1", "f2")).toBe("s1:f2");
  });
});

describe("parseShareUrl / extractShareId", () => {
  it("取 /s/ 后第一段为 share_id", () => {
    const url = parseShareUrl("https://www.alipan.com/s/wDtnwT8ErHW/folder/abc");
    expect(extractShareId(url)).toBe("wDtnwT8ErHW");
  });

  it("拒绝非分享 host 与非法路径", () => {
    expect(() => parseShareUrl("https://example.com/s/abc")).toThrow(
      "仅支持 www.alipan.com 或 *.aliyundrive.com 分享链接",
    );
    expect(() => parseShareUrl("https://www.alipan.com/drive/abc")).toThrow(
      "链接路径须以 /s/ 开头",
    );
    const parsed = parseShareUrl("https://www.alipan.com/s/");
    expect(() => extractShareId(parsed)).toThrow("链接中缺少 share_id");
  });

  it("逐字错误文案", () => {
    expect(() => parseShareUrl("   ")).toThrow("链接不能为空");
    expect(() => parseShareUrl("www.alipan.com/s/abc")).toThrow("链接须以 http(s):// 开头");
    expect(() => parseShareUrl("ftp://www.alipan.com/s/abc")).toThrow(
      "链接须以 http(s):// 开头",
    );
    expect(() => parseShareUrl("https://pan.baidu.com/s/abc")).toThrow(
      "仅支持 www.alipan.com 或 *.aliyundrive.com 分享链接",
    );
    expect(() => parseShareUrl("https://www.alipan.com/t/abc")).toThrow(
      "链接路径须以 /s/ 开头",
    );
    expect(() => extractShareId(parseShareUrl("https://www.alipan.com/s/"))).toThrow(
      "链接中缺少 share_id",
    );
  });

  it("接受 aliyundrive.com、子域名、端口与 query", () => {
    expect(extractShareId(parseShareUrl("https://aliyundrive.com/s/abc123"))).toBe("abc123");
    expect(extractShareId(parseShareUrl("http://share.aliyundrive.com/s/xyz?pwd=1"))).toBe("xyz");
    expect(extractShareId(parseShareUrl("https://www.alipan.com:443/s/p1/folder"))).toBe("p1");
    expect(extractShareId(parseShareUrl("  https://www.alipan.com/s/trimmed  "))).toBe("trimmed");
  });

  it("host 大小写不敏感，scheme 大小写仍拒绝", () => {
    expect(extractShareId(parseShareUrl("https://WWW.ALIPAN.COM/s/abc"))).toBe("abc");
    expect(() => parseShareUrl("HTTPS://www.alipan.com/s/abc")).toThrow(
      "链接须以 http(s):// 开头",
    );
  });
});

describe("normalizeDefinition", () => {
  it("大小写不敏感", () => {
    expect(normalizeDefinition("hd")).toBe("HD");
    expect(normalizeDefinition("  auto ")).toBe("AUTO");
    expect(normalizeDefinition("SD")).toBe("SD");
  });

  it("非法档位报错", () => {
    expect(() => normalizeDefinition("4K")).toThrow("definition 仅支持 AUTO/HD/SD");
  });
});

describe("config 落盘 roundtrip", () => {
  it("空库返回默认 AUTO", async () => {
    await expect(getConfig(dir)).resolves.toEqual({ definition: "AUTO" });
  });

  it("set/get 大小写归一并落盘", async () => {
    await setConfig(dir, { target_dir: "/tmp/dl", definition: "hd" });
    await expect(getConfig(dir)).resolves.toEqual({ target_dir: "/tmp/dl", definition: "HD" });
    const raw = await readRaw();
    expect(raw["config"]).toEqual({ target_dir: "/tmp/dl", definition: "HD" });
  });

  it("非法 definition 拒绝落盘", async () => {
    await expect(setConfig(dir, { definition: "4K" })).rejects.toThrow(
      "definition 仅支持 AUTO/HD/SD",
    );
  });

  it("缺省 target_dir 落盘写 null", async () => {
    await setConfig(dir, { definition: "SD" });
    const raw = await readRaw();
    expect(raw["config"]).toEqual({ target_dir: null, definition: "SD" });
  });
});

describe("collections 增删改（alipan）", () => {
  const fetchShareName = vi.fn(async (shareId: string) => `分享-${shareId}`);

  beforeEach(() => fetchShareName.mockClear());

  it("addCollection 新链接调元信息并落盘整数 created_at", async () => {
    const before = nowSecs();
    const item = await addCollection(
      dir,
      { kind: "alipan", url: "https://www.alipan.com/s/wDtnwT8ErHW" },
      { fetchShareName },
    );
    expect(fetchShareName).toHaveBeenCalledWith("wDtnwT8ErHW", undefined);
    expect(item.id).toBe("wDtnwT8ErHW");
    expect(item.kind).toBe("alipan");
    expect(item.share_id).toBe("wDtnwT8ErHW");
    expect(item.name).toBe("分享-wDtnwT8ErHW");
    expect(item.url).toBe("https://www.alipan.com/s/wDtnwT8ErHW");
    expect(Number.isInteger(item.created_at)).toBe(true);
    expect(item.created_at).toBeGreaterThanOrEqual(before);
    expect(item.pwd).toBeUndefined();

    const raw = await readRaw();
    const collections = raw["collections"] as Array<Record<string, unknown>>;
    expect(collections).toHaveLength(1);
    expect(collections[0]).toEqual({
      id: "wDtnwT8ErHW",
      kind: "alipan",
      name: "分享-wDtnwT8ErHW",
      created_at: item.created_at,
      share_id: "wDtnwT8ErHW",
      url: "https://www.alipan.com/s/wDtnwT8ErHW",
      pwd: null,
      relDir: null,
      category: null,
    });
    await expect(listCollections(dir)).resolves.toEqual([item]);
  });

  it("addCollection 已存在 id 直接返回旧记录且不再请求元信息", async () => {
    const first = await addCollection(
      dir,
      { kind: "alipan", url: "https://www.alipan.com/s/dup1", pwd: "pw" },
      { fetchShareName },
    );
    fetchShareName.mockClear();
    const boom = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const second = await addCollection(
      dir,
      { kind: "alipan", url: "https://www.alipan.com/s/dup1/other" },
      { fetchShareName: boom },
    );
    expect(boom).not.toHaveBeenCalled();
    expect(second).toEqual(first);
    expect(fetchShareName).not.toHaveBeenCalled();
  });

  it("addCollection 空白 pwd 按无密码处理", async () => {
    const item = await addCollection(
      dir,
      { kind: "alipan", url: "https://www.alipan.com/s/nopwd", pwd: "   " },
      { fetchShareName },
    );
    expect(item.pwd).toBeUndefined();
    expect(fetchShareName).toHaveBeenCalledWith("nopwd", undefined);
  });

  it("renameCollection 空名 / 不存在报错", async () => {
    await addCollection(dir, { kind: "alipan", url: "https://www.alipan.com/s/r1" }, { fetchShareName });
    await expect(renameCollection(dir, "r1", "   ")).rejects.toThrow("名称不能为空");
    await expect(renameCollection(dir, "missing", "x")).rejects.toThrow("合集不存在");
    const renamed = await renameCollection(dir, "r1", "  新名  ");
    expect(renamed.name).toBe("新名");
    await expect(listCollections(dir)).resolves.toEqual([renamed]);
  });

  it("removeCollection 不存在报错，删除后列表为空", async () => {
    await expect(removeCollection(dir, "nope")).rejects.toThrow("合集不存在");
    await addCollection(dir, { kind: "alipan", url: "https://www.alipan.com/s/del1" }, { fetchShareName });
    await removeCollection(dir, "del1");
    await expect(listCollections(dir)).resolves.toEqual([]);
    await expect(removeCollection(dir, "del1")).rejects.toThrow("合集不存在");
  });
});

describe("collections（xiaohongshu，磁盘联动）", () => {
  let target = "";

  beforeEach(async () => {
    target = await mkdtemp(join(tmpdir(), "fastcut-target-"));
    await setConfig(dir, { target_dir: target });
  });

  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
  });

  it("addCollection 无 target_dir 抛错", async () => {
    const bare = await mkdtemp(join(tmpdir(), "fastcut-nodir-"));
    try {
      await expect(addCollection(bare, { kind: "xiaohongshu", name: "旅行" })).rejects.toThrow(
        "未配置目标文件夹",
      );
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("addCollection 建 collections/<slug>/ 目录并记录 relDir", async () => {
    const item = await addCollection(dir, { kind: "xiaohongshu", name: "旅行" });
    expect(item.kind).toBe("xiaohongshu");
    expect(item.name).toBe("旅行");
    expect(item.id.startsWith("xhs_")).toBe(true);
    expect(item.relDir).toMatch(/^collections\/.+/);
    await expect(stat(join(target, item.relDir as string))).resolves.toBeTruthy();
    await expect(listCollections(dir)).resolves.toEqual([item]);
  });

  it("addCollection 空名抛错", async () => {
    await expect(addCollection(dir, { kind: "xiaohongshu", name: "   " })).rejects.toThrow(
      "名称不能为空",
    );
  });

  it("renameCollection 重命名磁盘文件夹并更新 relDir", async () => {
    const item = await addCollection(dir, { kind: "xiaohongshu", name: "旧名" });
    const oldRel = item.relDir as string;
    const renamed = await renameCollection(dir, item.id, "新名");
    expect(renamed.name).toBe("新名");
    expect(renamed.relDir).not.toBe(oldRel);
    expect(renamed.relDir as string).toContain("新名");
    // 短 id 后缀保持稳定
    expect((renamed.relDir as string).split("-").pop()).toBe(oldRel.split("-").pop());
    await expect(stat(join(target, renamed.relDir as string))).resolves.toBeTruthy();
  });

  it("removeCollection 连带删除磁盘文件夹", async () => {
    const item = await addCollection(dir, { kind: "xiaohongshu", name: "待删" });
    const rel = item.relDir as string;
    await writeFile(join(target, rel, "note.txt"), "x");
    await removeCollection(dir, item.id);
    await expect(listCollections(dir)).resolves.toEqual([]);
    await expect(stat(join(target, rel))).rejects.toThrow();
  });
});

describe("status_for", () => {
  it("无记录 → none；有记录但文件缺失 → none", async () => {
    await expect(getStatus(dir, "s", "f")).resolves.toEqual({ file_id: "f", state: "none" });
    await recordLedger(dir, "s", "f", {
      path: join(dir, "gone.mp4"),
      saved_at: nowSecs(),
      template: "HD",
    });
    await expect(getStatus(dir, "s", "f")).resolves.toEqual({ file_id: "f", state: "none" });
  });

  it("ledger 有记录且文件存在 → saved 带 path", async () => {
    const p = join(dir, "a.mp4");
    await writeFile(p, "x");
    await recordLedger(dir, "s", "f", { path: p, saved_at: nowSecs(), template: "HD" });
    await expect(getStatus(dir, "s", "f")).resolves.toEqual({
      file_id: "f",
      state: "saved",
      path: p,
    });
  });

  it("in-flight → downloading（注入优先于 ledger）", async () => {
    const p = join(dir, "b.mp4");
    await writeFile(p, "x");
    await recordLedger(dir, "s", "f", { path: p, saved_at: nowSecs(), template: "HD" });
    await expect(
      getStatus(dir, "s", "f", { isDownloading: () => true }),
    ).resolves.toEqual({ file_id: "f", state: "downloading" });
  });

  it("模块级 provider 生效且可恢复默认", async () => {
    expect(getIsDownloadingProvider()("s", "f")).toBe(false);
    setIsDownloadingProvider((shareId) => shareId === "s");
    await expect(getStatus(dir, "s", "f")).resolves.toEqual({
      file_id: "f",
      state: "downloading",
    });
  });

  it("getStatusBatch 逐项返回", async () => {
    const p = join(dir, "c.mp4");
    await writeFile(p, "x");
    await recordLedger(dir, "s", "f1", { path: p, saved_at: nowSecs(), template: "SD" });
    await expect(getStatusBatch(dir, "s", ["f1", "f2"])).resolves.toEqual([
      { file_id: "f1", state: "saved", path: p },
      { file_id: "f2", state: "none" },
    ]);
  });
});

describe("旧数据迁移", () => {
  it("legacyStorePath 覆盖三平台约定", () => {
    const fakeEnv = { HOME: `${sep}home${sep}u`, APPDATA: "C:\\Roam", XDG_DATA_HOME: "/xdg" };
    expect(legacyStorePath("darwin", fakeEnv)).toBe(
      join(`${sep}home${sep}u`, "Library", "Application Support", "com.fastcut.app", STORE_FILE),
    );
    expect(legacyStorePath("win32", fakeEnv)).toBe(join("C:\\Roam", "com.fastcut.app", STORE_FILE));
    expect(legacyStorePath("linux", fakeEnv)).toBe(join("/xdg", "com.fastcut.app", STORE_FILE));
    expect(
      legacyStorePath("linux", { HOME: `${sep}home${sep}u` }),
    ).toBe(
      join(`${sep}home${sep}u`, ".local", "share", "com.fastcut.app", STORE_FILE),
    );
  });

  it("目标缺失时从旧 Tauri 路径拷贝并继续使用", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "fastcut-fakehome-"));
    try {
      process.env["HOME"] = fakeHome;
      const legacyDir = join(
        fakeHome,
        "Library",
        "Application Support",
        "com.fastcut.app",
      );
      await mkdir(legacyDir, { recursive: true });
      const legacyPayload = {
        config: { target_dir: "/old/dir", definition: "HD" },
        ledger: { "s:f": { path: "/old/a.mp4", saved_at: 1700000000, template: "HD" } },
        shares: [
          {
            share_id: "olds",
            url: "https://www.alipan.com/s/olds",
            name: "旧分享",
            pwd: null,
            added_at: 1700000001,
          },
        ],
      };
      await writeFile(join(legacyDir, STORE_FILE), JSON.stringify(legacyPayload, null, 2));

      await expect(getConfig(dir)).resolves.toEqual({
        target_dir: "/old/dir",
        definition: "HD",
      });
      await expect(listCollections(dir)).resolves.toEqual([
        {
          id: "olds",
          kind: "alipan",
          name: "旧分享",
          created_at: 1700000001,
          share_id: "olds",
          url: "https://www.alipan.com/s/olds",
        },
      ]);
      // 已拷贝到新位置
      await expect(readFile(storeFile(), "utf8")).resolves.toContain("olds");
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("旧 shares 落盘读出即迁移为 collections（id 复用 share_id）", async () => {
    await writeFile(
      storeFile(),
      JSON.stringify({
        config: { target_dir: null, definition: "AUTO" },
        ledger: {},
        shares: [
          { share_id: "a1", url: "https://www.alipan.com/s/a1", name: "A", pwd: "p", added_at: 11 },
          { share_id: "b2", url: "https://www.alipan.com/s/b2", name: "B", pwd: null, added_at: 22 },
        ],
      }),
    );
    await expect(listCollections(dir)).resolves.toEqual([
      { id: "a1", kind: "alipan", name: "A", created_at: 11, share_id: "a1", url: "https://www.alipan.com/s/a1", pwd: "p" },
      { id: "b2", kind: "alipan", name: "B", created_at: 22, share_id: "b2", url: "https://www.alipan.com/s/b2" },
    ]);
  });

  it("无旧文件时静默用空数据", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "fastcut-emptyhome-"));
    try {
      process.env["HOME"] = fakeHome;
      await expect(getConfig(dir)).resolves.toEqual({ definition: "AUTO" });
      await expect(listCollections(dir)).resolves.toEqual([]);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("旧文件损坏时静默用空数据且不抛错", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "fastcut-badhome-"));
    try {
      process.env["HOME"] = fakeHome;
      const legacyDir = join(fakeHome, "Library", "Application Support", "com.fastcut.app");
      await mkdir(legacyDir, { recursive: true });
      await writeFile(join(legacyDir, STORE_FILE), "not-json{{{");
      await expect(getConfig(dir)).resolves.toEqual({ definition: "AUTO" });
      await expect(listCollections(dir)).resolves.toEqual([]);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("homedir 回退：HOME 缺省时仍可用（不抛错）", async () => {
    delete process.env["HOME"];
    // homedir() 指向真实家目录；仅断言不抛错且返回合法形状
    const cfg = await getConfig(dir);
    expect(typeof cfg.definition).toBe("string");
    expect(homedir()).toBeTruthy();
  });
});

describe("collections 分类（category，可空）", () => {
  const fetchShareName = async (shareId: string): Promise<string> => `分享-${shareId}`;

  it("normalizeCategory 去空白，空串视为未分类，超长抛错", () => {
    expect(normalizeCategory(undefined)).toBeUndefined();
    expect(normalizeCategory("  学习 ")).toBe("学习");
    expect(normalizeCategory("   ")).toBeUndefined();
    expect(() => normalizeCategory("a".repeat(33))).toThrow("分类名过长");
  });

  it("addCollection 可带分类落盘，无分类时不写字段", async () => {
    const withCat = await addCollection(
      dir,
      { kind: "alipan", url: "https://www.alipan.com/s/cat1", category: "  学习 " },
      { fetchShareName },
    );
    expect(withCat.category).toBe("学习");
    const plain = await addCollection(
      dir,
      { kind: "alipan", url: "https://www.alipan.com/s/cat2" },
      { fetchShareName },
    );
    expect(plain.category).toBeUndefined();
    const raw = await readRaw();
    const collections = raw["collections"] as Array<Record<string, unknown>>;
    expect(collections.find((c) => c["id"] === "cat1")?.["category"]).toBe("学习");
    expect(collections.find((c) => c["id"] === "cat2")?.["category"]).toBeNull();
  });

  it("setCollectionCategory 设置/清空/不存在报错", async () => {
    await addCollection(
      dir,
      { kind: "alipan", url: "https://www.alipan.com/s/catset" },
      { fetchShareName },
    );
    const updated = await setCollectionCategory(dir, "catset", "素材");
    expect(updated.category).toBe("素材");
    await expect(listCollections(dir)).resolves.toEqual([updated]);
    const cleared = await setCollectionCategory(dir, "catset", "   ");
    expect(cleared.category).toBeUndefined();
    await expect(setCollectionCategory(dir, "missing", "x")).rejects.toThrow("合集不存在");
    await expect(setCollectionCategory(dir, "catset", "b".repeat(40))).rejects.toThrow(
      "分类名过长",
    );
  });

  it("旧落盘无 category 字段时读出为未分类", async () => {
    await writeFile(
      storeFile(),
      JSON.stringify({
        config: { target_dir: null, definition: "AUTO" },
        ledger: {},
        collections: [
          {
            id: "old1",
            kind: "alipan",
            name: "旧",
            created_at: 11,
            share_id: "old1",
            url: "https://www.alipan.com/s/old1",
            pwd: null,
            relDir: null,
          },
        ],
      }),
    );
    await expect(listCollections(dir)).resolves.toEqual([
      {
        id: "old1",
        kind: "alipan",
        name: "旧",
        created_at: 11,
        share_id: "old1",
        url: "https://www.alipan.com/s/old1",
      },
    ]);
  });
});

describe("侧栏排序持久化", () => {
  const fetchShareName = async (shareId: string): Promise<string> => `分享-${shareId}`;

  async function addAlipan(id: string, category?: string) {
    return addCollection(
      dir,
      category === undefined
        ? { kind: "alipan", url: `https://www.alipan.com/s/${id}` }
        : { kind: "alipan", url: `https://www.alipan.com/s/${id}`, category },
      { fetchShareName },
    );
  }

  it("normalizeCategoryKey 去空白，空即哨兵", () => {
    expect(normalizeCategoryKey(undefined)).toBe("");
    expect(normalizeCategoryKey(null)).toBe("");
    expect(normalizeCategoryKey("   ")).toBe("");
    expect(normalizeCategoryKey("  学习 ")).toBe("学习");
  });

  it("旧文件无新字段时兼容读取为空序", async () => {
    await writeFile(
      storeFile(),
      JSON.stringify({
        config: { target_dir: null, definition: "AUTO" },
        ledger: {},
        collections: [
          {
            id: "o1",
            kind: "alipan",
            name: "旧",
            created_at: 11,
            share_id: "o1",
            url: "https://www.alipan.com/s/o1",
            pwd: null,
            relDir: null,
            category: "学习",
          },
        ],
      }),
    );
    await expect(getSidebarOrders(dir)).resolves.toEqual({
      category_order: [],
      collection_orders: {},
    });
    await expect(listCollections(dir)).resolves.toHaveLength(1);
  });

  it("非法新字段回默认", async () => {
    await writeFile(
      storeFile(),
      JSON.stringify({
        config: { target_dir: null, definition: "AUTO" },
        ledger: {},
        collections: [],
        category_order: "bad",
        collection_orders: [1, 2],
      }),
    );
    await expect(getSidebarOrders(dir)).resolves.toEqual({
      category_order: [],
      collection_orders: {},
    });
  });

  it("addCollection 维护分组序与分类序", async () => {
    await addAlipan("a1", "学习");
    await addAlipan("a2", "学习");
    await addAlipan("u1");
    const orders = await getSidebarOrders(dir);
    expect(orders.category_order).toEqual(["学习", ""]);
    expect(orders.collection_orders["学习"]).toEqual(["a1", "a2"]);
    expect(orders.collection_orders[""]).toEqual(["u1"]);
    const raw = await readRaw();
    expect(raw["category_order"]).toEqual(["学习", ""]);
    expect(raw["collection_orders"]).toEqual({ 学习: ["a1", "a2"], "": ["u1"] });
  });

  it("reorderCategories 去重/剪枝/补缺并保留哨兵", async () => {
    await addAlipan("b1", "B");
    await addAlipan("b2", "A");
    await addAlipan("b3");
    const effective = await reorderCategories(dir, ["  A ", "A", "stale", "", "B"]);
    expect(effective).toEqual(["A", "", "B"]);
    await expect(getSidebarOrders(dir)).resolves.toMatchObject({
      category_order: ["A", "", "B"],
    });
    const partial = await reorderCategories(dir, ["B"]);
    expect(partial).toEqual(["B", "A", ""]);
  });

  it("reorderCollections 正常换序与缺失补尾", async () => {
    await addAlipan("c1", "学习");
    await addAlipan("c2", "学习");
    await addAlipan("c3", "学习");
    await reorderCollections(dir, "学习", ["c3", "c1"]);
    await expect(getSidebarOrders(dir)).resolves.toMatchObject({
      collection_orders: expect.objectContaining({ 学习: ["c3", "c1", "c2"] }),
    });
    const group = (await listCollections(dir)).filter((c) => c.category === "学习");
    expect(getOrderedCollections(group, ["c3", "c1", "c2"]).map((c) => c.id)).toEqual([
      "c3",
      "c1",
      "c2",
    ]);
  });

  it("reorderCollections 跨组与不存在 id 抛错", async () => {
    await addAlipan("d1", "A");
    await addAlipan("d2", "B");
    await expect(reorderCollections(dir, "A", ["d2"])).rejects.toThrow("只能在同分类内排序");
    await expect(reorderCollections(dir, "A", ["missing"])).rejects.toThrow(
      "只能在同分类内排序",
    );
    await expect(reorderCollections(dir, "", ["d1"])).rejects.toThrow("只能在同分类内排序");
  });

  it("setCollectionCategory 旧组移除新组尾部追加", async () => {
    await addAlipan("e1", "A");
    await addAlipan("e2", "A");
    await setCollectionCategory(dir, "e1", "B");
    const orders = await getSidebarOrders(dir);
    expect(orders.collection_orders["A"]).toEqual(["e2"]);
    expect(orders.collection_orders["B"]).toEqual(["e1"]);
    expect(orders.category_order).toEqual(expect.arrayContaining(["A", "B"]));
    await setCollectionCategory(dir, "e2", "B");
    const after = await getSidebarOrders(dir);
    expect(after.collection_orders["A"]).toBeUndefined();
    expect(after.collection_orders["B"]).toEqual(["e1", "e2"]);
    expect(after.category_order).not.toContain("A");
  });

  it("removeCollection 剪枝两处", async () => {
    await addAlipan("f1", " solo ");
    await removeCollection(dir, "f1");
    await expect(getSidebarOrders(dir)).resolves.toEqual({
      category_order: [],
      collection_orders: {},
    });
  });

  it("renameCollection 不动排序", async () => {
    await addAlipan("g1", "A");
    await addAlipan("g2", "A");
    const before = await getSidebarOrders(dir);
    await renameCollection(dir, "g1", "新名");
    await expect(getSidebarOrders(dir)).resolves.toEqual(before);
  });

  it("getOrderedCategories 存储序优先未知字母序", () => {
    expect(getOrderedCategories(["B", "A", "C"], ["C"])).toEqual(["C", "A", "B"]);
    expect(getOrderedCategories(["B", "A"], [])).toEqual(["A", "B"]);
  });
});
