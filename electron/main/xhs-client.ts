/**
 * 小红书解析客户端（M3，仅视频期）。
 *
 * 非官方解析链（2026-10-11 实测 profile `20260907`，前端 chunk 逆向）：
 * - `GET https://dy.kukutool.com/` 拿 cookie；
 * - `POST /api/auth-970b03 {requestURL, pagePath:"/xiaohongshu", mode:"single"}`
 *   取 `k_970b03` / `s_970b03`（profile 会轮换：`authRoute` + `k/s/p/r/i` 后缀，
 *   旧 profile 会回 404 + `reason: pi_<suffix>` = ticket_profile_inactive）；
 * - AES-256-GCM 加密参数（key=`sha256(key:seed)`，12 字节随机 nonce，
 *   密文+tag 标准 b64）得到
 *   `{version:3, k_970b03, p_970b03, r_970b03:1, i_970b03}`，
 *   内层参数含 `qualityTier: "hd"`（高清）；
 * - `POST /api/parse` 返回 `{status:0, encrypt:true, data, iv}`，经
 *   `XOR(0x5A) → 8 字节块反转 → 自定义 B64 表 → AES-256-CBC`
 *   （key=`sha256("12345678901234567890123456789013")`，注意不是原文 UTF-8）
 *   解出 `{title, type, cover, url, videos, pics}`。
 * - 短链 `xhslink.com` 先跟随跳转到完整 URL 再送解析。
 *
 * 运行环境：Node 22 全局 `fetch` + `node:crypto` 原生加解密，无重型依赖。
 * `fetch` 可经构造器注入，便于 vitest mock（不打真实网络）。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** kukutool 站点基址。 */
export const KUKU_BASE = "https://dy.kukutool.com";
/** 当前 profile id（前端 `activeProfileId`，改版追踪用）。 */
export const KUKU_PROFILE_ID = "20260907";
/** 鉴权路由（对方改版时最先变的就是这里，透传文案见各方法的错误前缀）。 */
export const KUKU_AUTH_ROUTE = "auth-970b03";
/** profile 字段后缀（auth 响应 key/seed，parse 请求 key/payload/version/iv）。 */
export const KUKU_FIELD_SUFFIX = "970b03";
/** 解析页路径（auth 与加密内参的 `pagePath`，与浏览器地址栏一致）。 */
export const KUKU_PAGE_PATH = "/xiaohongshu";
/** 默认画质档：`"hd"` = 高清（前端另有 `"standard"` 正常画质）。 */
export type XhsQualityTier = "standard" | "hd";
export const DEFAULT_QUALITY_TIER: XhsQualityTier = "hd";
/** 解析响应 key 常量（前端仍明文传递；实际 AES key 为其 SHA-256）。 */
export const KUKU_RESPONSE_KEY = "12345678901234567890123456789013";
/** 标准 B64 表。 */
export const STANDARD_B64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** 自定义 B64 表（→ 标准表的映射源）。 */
export const CUSTOM_B64 =
  "ZYXABCDEFGHIJKLMNOPQRSTUVWzyxabcdefghijklmnopqrstuvw9876543210-_";
/** XOR 密钥。 */
export const XOR_KEY = 0x5a;
/** 块反转粒度。 */
export const BLOCK_SIZE = 8;

export interface XhsAuth {
  key: string;
  seed: string;
}

export interface XhsParseResult {
  title: string;
  downloadUrl: string;
  cover: string;
  noteId: string;
  author: string;
}

// ---------------------------------------------------------------------------
// 纯函数（单独导出，供单测；与 kukutool.py 的同名方法逐一对应）
// ---------------------------------------------------------------------------

/** 与 `_xorstring` 对应：逐字符 `^ key`（默认 `0x5A`）。 */
export function xorString(s: string, key: number = XOR_KEY): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    out += String.fromCharCode(s.charCodeAt(i) ^ key);
  }
  return out;
}

/** 与 `_blockreverse` 对应：按 `blockSize`（默认 8）分块逐块反转。 */
export function blockReverse(s: string, blockSize: number = BLOCK_SIZE): string {
  let out = "";
  for (let i = 0; i < s.length; i += blockSize) {
    out += s.slice(i, i + blockSize).split("").reverse().join("");
  }
  return out;
}

/**
 * 与 `_base64customdecode` 对应：自定义表字符 → 标准表同下标字符，
 * 不在表内的字符（如 `=` 填充）原样保留。
 */
export function customB64decode(s: string): string {
  let out = "";
  for (const ch of s) {
    const idx = CUSTOM_B64.indexOf(ch);
    out += idx === -1 ? ch : STANDARD_B64[idx];
  }
  return out;
}

/** 自定义表编码（`customB64decode` 的逆操作，测试构造向量用）。 */
export function customB64encode(s: string): string {
  let out = "";
  for (const ch of s) {
    const idx = STANDARD_B64.indexOf(ch);
    out += idx === -1 ? ch : CUSTOM_B64[idx];
  }
  return out;
}

/**
 * 视频标题清洗（落盘文件名用）：去掉 `/ \\ : * ? " < > |` 与控制字符，
 * 去掉首尾空白与尾部 `.`，截断 100 字符，空则回退 `"未命名"`。
 */
export function sanitizeTitle(raw: string): string {
  const cleaned = raw
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/[\0-\x1f]/g, "")
    .trim()
    .replace(/[. ]+$/g, "");
  if (cleaned === "") return "未命名";
  const chars = [...cleaned];
  return chars.length > 100 ? chars.slice(0, 100).join("") : cleaned;
}

/**
 * 从小红书 URL 提取 noteId，失败返回 `""`（不抛）：
 * - `.../explore/<hex>` → group 1；
 * - `.../discovery/item/<hex>` → group 2；
 * - `xhslink` 短链（跳转前无 id）→ `""`。
 */
export function extractNoteId(url: string): string {
  try {
    const m = /explore\/([0-9a-fA-F]+)|\/discovery\/item\/([0-9a-fA-F]+)|xhslink/.exec(url);
    if (!m) return "";
    return m[1] ?? m[2] ?? "";
  } catch {
    return "";
  }
}

/** 生成 `uwx_id`（`uwx_` + 12 位字母数字）。 */
export function genUwxId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const buf = randomBytes(12);
  let out = "uwx_";
  for (let i = 0; i < 12; i++) {
    const b = buf[i] ?? 0;
    out += chars[b % chars.length];
  }
  return out;
}

/**
 * 解密 `/api/parse` 返回的 `{data, iv}`（XOR → 块反转 → 自定义 B64 →
 * AES-256-CBC，key=`sha256(KUKU_RESPONSE_KEY)`）。
 * 失败时抛 `解析结果解密失败：<原因>`（附带上游载荷长度，不吞原始错误）。
 */
export function decryptPayload(data: string, iv: string): Record<string, unknown> {
  let dataM: string;
  let ivM: string;
  try {
    dataM = customB64decode(blockReverse(xorString(data)));
    ivM = customB64decode(blockReverse(xorString(iv)));
  } catch (e) {
    throw new Error(`解析结果解密失败：预处理失败：${errText(e)}`);
  }
  let plain: string;
  try {
    const decipher = createDecipheriv(
      "aes-256-cbc",
      responseKeyBytes(),
      Buffer.from(ivM, "base64"),
    );
    plain = Buffer.concat([
      decipher.update(Buffer.from(dataM, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (e) {
    throw new Error(`解析结果解密失败：AES-CBC 解密失败：${errText(e)}`);
  }
  try {
    return JSON.parse(plain) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`解析结果解密失败：JSON 解析失败：${errText(e)}`);
  }
}

/** 响应 AES key：`sha256(KUKU_RESPONSE_KEY)`（2026-10-11 实测，旧版为原文 UTF-8）。 */
export function responseKeyBytes(): Buffer {
  return createHash("sha256").update(KUKU_RESPONSE_KEY, "utf8").digest();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function defaultHeaders(cookie?: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    origin: KUKU_BASE,
    referer: `${KUKU_BASE}${KUKU_PAGE_PATH}`,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  };
  if (cookie !== undefined && cookie !== "") h["cookie"] = cookie;
  return h;
}

function getSetCookies(resp: Response): string[] {
  const fn = (resp.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof fn === "function") {
    try {
      return fn.call(resp.headers);
    } catch {
      return [];
    }
  }
  const single = resp.headers.get("set-cookie");
  return single === null || single === "" ? [] : [single];
}

function mergeCookie(current: string, resp: Response): string {
  const jar = new Map<string, string>();
  for (const item of current.split(";").map((s) => s.trim()).filter(Boolean)) {
    const i = item.indexOf("=");
    if (i > 0) jar.set(item.slice(0, i), item.slice(i + 1));
  }
  for (const c of getSetCookies(resp)) {
    const pair = c.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// ---------------------------------------------------------------------------
// XhsClient
// ---------------------------------------------------------------------------

export class XhsClient {
  private readonly fetchFn: typeof fetch;
  private cookie: string = "";

  constructor(fetchFn?: typeof fetch) {
    this.fetchFn = fetchFn ?? fetch;
  }

  /** 仅测试用：读取当前 cookie jar。 */
  getCookie(): string {
    return this.cookie;
  }

  /**
   * 短链跟随跳转：`xhslink.com` 先 GET 跟随到完整 URL 再返回；
   * 非短链原样返回（trim）。跟随上限 5 跳，失败返回原 URL（不抛，
   * 解析阶段再报错）。
   */
  async resolveUrl(url: string): Promise<string> {
    const trimmed = url.trim();
    if (trimmed === "") throw new Error("链接不能为空");
    if (!trimmed.includes("xhslink.com")) return trimmed;
    let cur = trimmed;
    for (let i = 0; i < 5; i++) {
      let resp: Response;
      try {
        resp = await this.fetchFn(cur, { method: "GET", redirect: "manual" });
      } catch {
        return cur;
      }
      const loc = resp.headers.get("location");
      if (
        (resp.status === 301 ||
          resp.status === 302 ||
          resp.status === 303 ||
          resp.status === 307 ||
          resp.status === 308) &&
        loc !== null &&
        loc !== ""
      ) {
        try {
          cur = new URL(loc, cur).toString();
        } catch {
          return cur;
        }
        continue;
      }
      // 自动跟随的实现（undici 默认 follow）经 `response.url` 暴露终点。
      const finalUrl = (resp as Response & { url?: string }).url;
      if (typeof finalUrl === "string" && finalUrl !== "" && finalUrl !== cur) {
        return finalUrl;
      }
      return cur;
    }
    return cur;
  }

  /** `GET /` 拿 cookie（存入实例 jar，供后续 auth/parse 复用）。 */
  async ensureSession(): Promise<string> {
    if (this.cookie !== "") return this.cookie;
    const resp = await this.fetchFn(`${KUKU_BASE}/`, {
      method: "GET",
      headers: defaultHeaders(),
    });
    this.cookie = mergeCookie("", resp);
    return this.cookie;
  }

  /**
   * 鉴权：`POST /api/<KUKU_AUTH_ROUTE>` 取 `{key, seed}`（即 `k_<suffix>/s_<suffix>`）。
   * 对方改版（非 200 / 字段缺失）时把上游原文截 200 字透传。
   */
  async auth(url: string): Promise<XhsAuth> {
    await this.ensureSession();
    const body = { requestURL: url, pagePath: KUKU_PAGE_PATH, mode: "single" };
    let resp: Response;
    try {
      resp = await this.fetchFn(`${KUKU_BASE}/api/${KUKU_AUTH_ROUTE}`, {
        method: "POST",
        headers: defaultHeaders(this.cookie),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`小红书解析鉴权失败：网络错误：${errText(e)}`);
    }
    this.cookie = mergeCookie(this.cookie, resp);
    const text = await resp.text().catch((e: unknown) => {
      throw new Error(`小红书解析鉴权失败：读取响应失败：${errText(e)}`);
    });
    if (!resp.ok) {
      throw new Error(`小红书解析鉴权失败（HTTP ${resp.status}）：${text.slice(0, 200)}`);
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`小红书解析鉴权失败：非 JSON 响应：${text.slice(0, 200)}`);
    }
    const key = json[`k_${KUKU_FIELD_SUFFIX}`];
    const seed = json[`s_${KUKU_FIELD_SUFFIX}`];
    if (typeof key !== "string" || key === "" || typeof seed !== "string" || seed === "") {
      throw new Error(`小红书解析鉴权失败：返回字段缺失：${text.slice(0, 200)}`);
    }
    return { key, seed };
  }

  /**
   * 构造 `/api/parse` 请求体：AES-256-GCM 加密参数
   *  （key=`sha256(key:seed)`，12 字节随机 nonce，密文+tag 标准 b64），
   *   信封字段名取当前 profile 后缀；内层带 `qualityTier`（默认高清）。
   */
  buildParseBody(
    url: string,
    key: string,
    seed: string,
    qualityTier: XhsQualityTier = DEFAULT_QUALITY_TIER,
  ): Record<string, unknown> {
    const params = {
      requestURL: url,
      captchaKey: "",
      captchaInput: "",
      totalSuccessCount: "0",
      successCount: "0",
      firstSuccessDate: "",
      pagePath: KUKU_PAGE_PATH,
      uwx_id: genUwxId(),
      isMobile: "false",
      geoipIp: "",
      country_code: null,
      confirmPurchased: false,
      qualityTier,
      quoteToken: null,
    };
    const keyBytes = createHash("sha256").update(`${key}:${seed}`, "utf8").digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(params), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const s = KUKU_FIELD_SUFFIX;
    return {
      version: 3,
      [`k_${s}`]: key,
      [`p_${s}`]: ciphertext.toString("base64"),
      [`r_${s}`]: 1,
      [`i_${s}`]: iv.toString("base64"),
    };
  }

  /** 解密 `/api/parse` 的 `{data, iv}`（独立导出 `decryptPayload` 的方法版）。 */
  decrypt(data: string, iv: string): Record<string, unknown> {
    return decryptPayload(data, iv);
  }

  /**
   * 解析一条小红书链接（仅视频期）：短链先跳转 → 鉴权 → parse → 解密 →
   * `{title, downloadUrl, cover, noteId, author}`（默认高清）。
   * 图集笔记（无 `url` 但有 `pics`）抛 `仅支持视频笔记，图集笔记暂不支持`；
   * 对方改版（非 200 / 字段缺失）把上游原文截 200 字透传。
   */
  async parse(url: string, qualityTier: XhsQualityTier = DEFAULT_QUALITY_TIER): Promise<XhsParseResult> {
    const trimmed = url.trim();
    if (trimmed === "") throw new Error("链接不能为空");
    const resolved = await this.resolveUrl(trimmed);
    const noteId = extractNoteId(resolved);
    const { key, seed } = await this.auth(resolved);
    const reqBody = this.buildParseBody(resolved, key, seed, qualityTier);
    let resp: Response;
    try {
      resp = await this.fetchFn(`${KUKU_BASE}/api/parse`, {
        method: "POST",
        headers: defaultHeaders(this.cookie),
        body: JSON.stringify(reqBody),
      });
    } catch (e) {
      throw new Error(`小红书解析失败：网络错误：${errText(e)}`);
    }
    this.cookie = mergeCookie(this.cookie, resp);
    const text = await resp.text().catch((e: unknown) => {
      throw new Error(`小红书解析失败：读取响应失败：${errText(e)}`);
    });
    if (!resp.ok) {
      throw new Error(`小红书解析失败（HTTP ${resp.status}）：${text.slice(0, 200)}`);
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`小红书解析失败：非 JSON 响应：${text.slice(0, 200)}`);
    }
    const raw = await this.unwrapParseData(json);
    const title = typeof raw["title"] === "string" ? (raw["title"] as string).trim() : "";
    const downloadUrl = pickVideoUrl(raw, qualityTier);
    if (downloadUrl === "") {
      const pics = raw["pics"];
      if (Array.isArray(pics) && pics.length > 0) {
        throw new Error("仅支持视频笔记，图集笔记暂不支持");
      }
      throw new Error(`小红书解析失败：未返回视频直链：${text.slice(0, 200)}`);
    }
    const cover =
      typeof raw["cover"] === "string" && (raw["cover"] as string) !== ""
        ? (raw["cover"] as string)
        : Array.isArray(raw["pics"]) && typeof raw["pics"][0] === "string"
          ? (raw["pics"][0] as string)
          : "";
    return { title, downloadUrl, cover, noteId, author: extractAuthor(raw) };
  }

  /** `/api/parse` 响应解包：加密形 `{data:string, iv:string}` 解密；明文形直接取。 */
  private async unwrapParseData(json: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = json["data"];
    const iv = json["iv"];
    if (typeof data === "string" && typeof iv === "string") {
      return this.decrypt(data, iv);
    }
    // 兼容对方偶发的明文/嵌套形状（改版前兆：缺字段即透传原文）。
    if (typeof data === "object" && data !== null) {
      return data as Record<string, unknown>;
    }
    const maybe = json["url"];
    if (typeof maybe === "string") return json;
    throw new Error(
      `小红书解析失败：返回字段缺失：${JSON.stringify(json).slice(0, 200)}`,
    );
  }
}

/**
 * 从解密载荷选视频直链：优先 `videos[].video_fullinfo[]` 中与目标档匹配的项
 * （`type` 含 “正常”/`standard` 走正常画质，含 “高清”/`hd` 走高清），
 * 否则回退顶层 `url`（服务端已按 `qualityTier` 下发），再回退首个 videos 项。
 */
export function pickVideoUrl(
  raw: Record<string, unknown>,
  qualityTier: XhsQualityTier = DEFAULT_QUALITY_TIER,
): string {
  const top = typeof raw["url"] === "string" ? (raw["url"] as string) : "";
  const videos = raw["videos"];
  const flats: { url: string; type: string }[] = [];
  if (Array.isArray(videos)) {
    for (const v of videos) {
      if (typeof v !== "object" || v === null) continue;
      const rec = v as Record<string, unknown>;
      const vurl = typeof rec["url"] === "string" ? (rec["url"] as string) : "";
      if (vurl !== "") flats.push({ url: vurl, type: "" });
      const full = rec["video_fullinfo"];
      if (Array.isArray(full)) {
        for (const f of full) {
          if (typeof f !== "object" || f === null) continue;
          const frec = f as Record<string, unknown>;
          const furl = typeof frec["url"] === "string" ? (frec["url"] as string) : "";
          const ftype = typeof frec["type"] === "string" ? (frec["type"] as string) : "";
          if (furl !== "") flats.push({ url: furl, type: ftype });
        }
      }
    }
  }
  const want =
    qualityTier === "hd" ? [/高清/i, /hd/i, /超清/i, /原画/i] : [/正常/i, /standard/i, /流畅/i, /标清/i];
  for (const re of want) {
    const hit = flats.find((f) => re.test(f.type));
    if (hit !== undefined) return hit.url;
  }
  if (top !== "") return top;
  return flats.length > 0 ? (flats[0]?.url ?? "") : "";
}

function extractAuthor(raw: Record<string, unknown>): string {
  const direct = raw["author"];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  if (typeof direct === "object" && direct !== null) {
    const rec = direct as Record<string, unknown>;
    for (const k of ["nickname", "name", "nick"]) {
      const v = rec[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
  }
  for (const k of ["nickname", "authorName", "user"]) {
    const v = raw[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "object" && v !== null) {
      const rec = v as Record<string, unknown>;
      for (const kk of ["nickname", "name", "nick"]) {
        const vv = rec[kk];
        if (typeof vv === "string" && vv.trim() !== "") return vv.trim();
      }
    }
  }
  return "";
}
