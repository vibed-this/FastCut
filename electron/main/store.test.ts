/**
 * store.ts 的 vitest 测试：Rust `store.rs #[cfg(test)]` 用例的直译 +
 * 落盘 roundtrip + 旧数据迁移。全部以临时目录充当 userDataDir。
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addShare,
  extractShareId,
  getConfig,
  getIsDownloadingProvider,
  getStatus,
  getStatusBatch,
  ledgerKey,
  legacyStorePath,
  listShares,
  normalizeDefinition,
  nowSecs,
  parseShareUrl,
  recordLedger,
  removeShare,
  renameShare,
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

describe("parseShareUrl / extractShareId（Rust tests 直译）", () => {
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

  it("host 大小写不敏感，scheme 大小写仍拒绝（与 Rust strip_prefix 一致）", () => {
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

  it("缺省 target_dir 落盘写 null（与 serde Option::None 一致）", async () => {
    await setConfig(dir, { definition: "SD" });
    const raw = await readRaw();
    expect(raw["config"]).toEqual({ target_dir: null, definition: "SD" });
  });
});

describe("shares 增删改", () => {
  const fetchShareName = vi.fn(async (shareId: string) => `分享-${shareId}`);

  beforeEach(() => fetchShareName.mockClear());

  it("addShare 新链接调元信息并落盘整数 added_at", async () => {
    const before = nowSecs();
    const item = await addShare(dir, "https://www.alipan.com/s/wDtnwT8ErHW", undefined, {
      fetchShareName,
    });
    expect(fetchShareName).toHaveBeenCalledWith("wDtnwT8ErHW", undefined);
    expect(item.share_id).toBe("wDtnwT8ErHW");
    expect(item.name).toBe("分享-wDtnwT8ErHW");
    expect(item.url).toBe("https://www.alipan.com/s/wDtnwT8ErHW");
    expect(Number.isInteger(item.added_at)).toBe(true);
    expect(item.added_at).toBeGreaterThanOrEqual(before);
    expect(item.pwd).toBeUndefined();

    const raw = await readRaw();
    const shares = raw["shares"] as Array<Record<string, unknown>>;
    expect(shares).toHaveLength(1);
    expect(shares[0]).toEqual({
      share_id: "wDtnwT8ErHW",
      url: "https://www.alipan.com/s/wDtnwT8ErHW",
      name: "分享-wDtnwT8ErHW",
      pwd: null,
      added_at: item.added_at,
    });
    await expect(listShares(dir)).resolves.toEqual([item]);
  });

  it("addShare 已存在 share_id 直接返回旧记录且不再请求元信息", async () => {
    const first = await addShare(dir, "https://www.alipan.com/s/dup1", "pw", { fetchShareName });
    fetchShareName.mockClear();
    const boom = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const second = await addShare(dir, "https://www.alipan.com/s/dup1/other", undefined, {
      fetchShareName: boom,
    });
    expect(boom).not.toHaveBeenCalled();
    expect(second).toEqual(first);
    expect(fetchShareName).not.toHaveBeenCalled();
  });

  it("addShare 空白 pwd 按无密码处理", async () => {
    const item = await addShare(dir, "https://www.alipan.com/s/nopwd", "   ", { fetchShareName });
    expect(item.pwd).toBeUndefined();
    expect(fetchShareName).toHaveBeenCalledWith("nopwd", undefined);
  });

  it("renameShare 空名 / 不存在报错", async () => {
    await addShare(dir, "https://www.alipan.com/s/r1", undefined, { fetchShareName });
    await expect(renameShare(dir, "r1", "   ")).rejects.toThrow("名称不能为空");
    await expect(renameShare(dir, "missing", "x")).rejects.toThrow("分享不存在");
    const renamed = await renameShare(dir, "r1", "  新名  ");
    expect(renamed.name).toBe("新名");
    await expect(listShares(dir)).resolves.toEqual([renamed]);
  });

  it("removeShare 不存在报错，删除后列表为空", async () => {
    await expect(removeShare(dir, "nope")).rejects.toThrow("分享不存在");
    await addShare(dir, "https://www.alipan.com/s/del1", undefined, { fetchShareName });
    await removeShare(dir, "del1");
    await expect(listShares(dir)).resolves.toEqual([]);
    await expect(removeShare(dir, "del1")).rejects.toThrow("分享不存在");
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
      await expect(listShares(dir)).resolves.toEqual([
        {
          share_id: "olds",
          url: "https://www.alipan.com/s/olds",
          name: "旧分享",
          added_at: 1700000001,
        },
      ]);
      // 已拷贝到新位置
      await expect(readFile(storeFile(), "utf8")).resolves.toContain("olds");
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("无旧文件时静默用空数据", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "fastcut-emptyhome-"));
    try {
      process.env["HOME"] = fakeHome;
      await expect(getConfig(dir)).resolves.toEqual({ definition: "AUTO" });
      await expect(listShares(dir)).resolves.toEqual([]);
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
      await expect(listShares(dir)).resolves.toEqual([]);
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
