/**
 * 阿里云盘分享匿名链路客户端：取 token → 列目录 → 取视频预览地址。
 *
 * 由旧 Tauri 后端 `src-tauri/src/share_api.rs`（main 分支）逐行直译，
 * 端点与报文形状以 2026-10-10 对 `wDtnwT8ErHW` 分享的实测为准：
 * - `POST {PDS}/v2/share_link/get_share_token`（注意无 `/adrive` 前缀）
 * - `POST {PDS}/adrive/v2/file/list_by_share`（需 `x-share-token`）
 * - `POST {PDS}/adrive/v2/file/get_video_preview_play_info_by_share`
 *   （`category: "quick_video"`，`video_preview_play_info.quick_video_list` 内嵌）
 * - `POST {PDS}/adrive/v3/share_link/get_share_by_anonymous?share_id={id}`
 *   （2026-10-11 浏览器实测为 v3 带 query；响应体与 v2 同形）
 * - 公共请求头 `X-Canary: client=web,app=share,version=v2.3.1`，
 *   `Origin: https://www.alipan.com`，`Referer: https://www.alipan.com/`，
 *   `User-Agent: Chrome/154`，`x-device-id: <进程级稳定 UUID>`。
 *   实测浏览器全程不发 `Cookie`，匿名链路无需登录态。
 * - `list_by_share` 必须带缩略图参数（`video_thumbnail_process` 等），
 *   响应每项自带 `thumbnail` 快照；列表禁止逐项调 preview 接口
 *   （逐项调是 `TooManyRequests` 的直接原因）。
 * - `share_token` 进程级复用（按 share_id+pwd 缓存），跨 `ShareClient`
 *   实例共享；`TooManyRequests` 时退避重试一次。
 *
 * 结构参考 alist `aliyundrive_share` 驱动：请求集中注入 canary/share-token，
 * 遇到 `ShareLinkTokenInvalid` 时刷新 token 后重试一次。不适用部分：
 * alist 的 OAuth 个人盘 `refreshToken` 体系——本模块只走匿名分享链，不碰登录态。
 * 已下线接口不在此实现：`get_share_link_download_url` 实测返回 410（即使带登录态），
 * 分享文件 `get_download_url` 返回 403，原画直下当前无可用端点。
 *
 * 运行环境：Node 22 全局 `fetch`，无第三方 HTTP 依赖。
 * URL 解析/校验（`parse_share_url` / `extract_share_id`）直译自旧后端
 * `src-tauri/src/store.rs` 的同名函数，中文报错逐字保留。
 *
 * 手动验证（需要可直连 api.aliyundrive.com 的网络，CI 默认不跑）：
 * 用 node 直接调导出的 `get_share_meta` / `list_share` 等自由函数即可，
 * 它们走全局 `fetch` 打真实端点（见 `electron/main/share-api.test.ts` 的 mock 用法）。
 */

import { randomUUID } from "node:crypto";

import type {
  Definition,
  ListShareResult,
  PickPreviewResult,
  ShareItem,
  ShareMeta,
  VideoPreview,
} from "../shared/contract";

export const PDS_ENDPOINT = "https://api.aliyundrive.com";
export const CANARY = "client=web,app=share,version=v2.3.1";
export const ORIGIN = "https://www.alipan.com";
/** 浏览器实测 UA（Chrome/154），匿名链路分桶更宽松。 */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
/** 进程级稳定设备 id（浏览器为固定值；此处进程内复用，避免每次随机被风控）。 */
export const DEVICE_ID = (() => {
  try {
    return randomUUID();
  } catch {
    return "00000000-0000-4000-8000-000000000000";
  }
})();
/** `list_by_share` 缩略图参数（与浏览器实测一致）：要快照必须带。 */
export const IMAGE_THUMBNAIL_PROCESS = "image/resize,w_256/format,jpeg";
export const IMAGE_URL_PROCESS = "image/resize,w_1920/format,jpeg/interlace,1";
export const VIDEO_THUMBNAIL_PROCESS = "video/snapshot,t_1000,f_jpg,ar_auto,w_256";
/** `TooManyRequests` 退避重试：只重试一次，避免雪崩。 */
export const RATE_LIMIT_RETRY_MS = 1000;
export const REQUEST_TIMEOUT_SECS = 30;
/** 单页条数上限兼默认值（与 Rust `LIST_PAGE_LIMIT` 一致）。 */
export const LIST_PAGE_LIMIT = 100;
export const PAGE_SIZE = LIST_PAGE_LIMIT;
/** `listAll` 翻页上限，防异常循环（与 Rust `LIST_MAX_PAGES` 一致）。 */
export const LIST_MAX_PAGES = 50;
/** share_token 缓存 TTL：站方 expires_in 为 7200，提前 200s 过期。 */
export const TOKEN_TTL_SECS = 7000;

/** token 失效时服务端返回的错误码（对齐 alist 驱动的重试条件）。 */
export const SHARE_TOKEN_INVALID_CODE = "ShareLinkTokenInvalid";

/** 服务端 Api 错误：`接口错误（{code}）：{message}`（中文文案逐字保留）。 */
export class ShareApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`接口错误（${code}）：${message}`);
    this.name = "ShareApiError";
    this.code = code;
  }
}

function transport_error(detail: unknown): Error {
  const text = detail instanceof Error ? detail.message : String(detail);
  return new Error(`网络错误：${text}`);
}

/** 是否为 token 失效错误（命中即刷新 token 后重试一次）。 */
export function is_share_token_invalid(err: unknown): boolean {
  return err instanceof ShareApiError && err.code === SHARE_TOKEN_INVALID_CODE;
}
export const isShareTokenInvalid = is_share_token_invalid;

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
}

async function parse_api_response<T>(resp: Response): Promise<T> {
  const status = resp.status;
  if (resp.ok) {
    try {
      return (await resp.json()) as T;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`响应解析失败（HTTP ${status}）：${detail}`);
    }
  }
  let code = "";
  let message = "";
  try {
    const body = (await resp.json()) as ApiErrorBody;
    if (typeof body.code === "string") code = body.code;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // 解析不出错误体就用默认 code，行为与 Rust `unwrap_or` 一致。
  }
  if (code === "") code = `HTTP_${status}`;
  throw new ShareApiError(code, message);
}

// ---------------------------------------------------------------------------
// 纯函数（单独导出，便于单测；直译 Rust 实现，行为逐条对照）
// ---------------------------------------------------------------------------

/**
 * 路径片段清洗：去掉 `/ \ \0` 后 trim，空则返回"未命名"，截断 100 字符。
 * downloader 会 import 它。
 */
export function sanitize_segment(raw: string): string {
  const cleaned = raw.replace(/[/\\\0]/g, "").trim();
  if (cleaned === "") return "未命名";
  const chars = [...cleaned];
  return chars.length > 100 ? chars.slice(0, 100).join("") : cleaned;
}
export const sanitizeSegment = sanitize_segment;

/** 一档转码模板是否可用：`status` 非 finished 或 `preview_url` 为空即不可用。 */
export function is_template_usable(t: VideoPreview): boolean {
  return (
    t.status === "finished" &&
    typeof t.preview_url === "string" &&
    t.preview_url.length > 0
  );
}
export const isTemplateUsable = is_template_usable;

/**
 * 按偏好选档：显式档（HD/SD/FHD，不分大小写）精确命中可用项，miss 则回退；
 * AUTO（或空/未知）取宽度最大的可用档。只考虑 finished 且有 preview_url 的项。
 * 并列最大宽度时取最后一项（与 Rust `max_by_key` 语义一致）。
 */
export function pick_template(
  templates: readonly VideoPreview[],
  preference: string,
): VideoPreview | undefined {
  const usable = templates.filter(is_template_usable);
  if (usable.length === 0) return undefined;
  const want = preference.trim().toUpperCase();
  if (want !== "" && want !== "AUTO") {
    const hit = usable.find((t) => t.template_id.toUpperCase() === want);
    if (hit !== undefined) return hit;
  }
  return usable.reduce<VideoPreview | undefined>(
    (best, cur) =>
      best === undefined || (cur.template_width ?? 0) >= (best.template_width ?? 0)
        ? cur
        : best,
    undefined,
  );
}
export const pickTemplate = pick_template;

/** `marker` 归一化：缺省/空白视为从头取（请求体里不带 marker 字段）。 */
export function normalize_marker(marker?: string | null): string | undefined {
  if (marker === undefined || marker === null) return undefined;
  const t = marker.trim();
  return t === "" ? undefined : t;
}
export const normalizeMarker = normalize_marker;

/** `limit` 归一化：服务端单页上限 100，越界收敛到默认值（与 Rust `match` 一致）。 */
export function normalize_limit(limit?: number | null): number {
  if (
    typeof limit === "number" &&
    Number.isFinite(limit) &&
    limit >= 1 &&
    limit <= LIST_PAGE_LIMIT
  ) {
    return Math.floor(limit);
  }
  return LIST_PAGE_LIMIT;
}
export const normalizeLimit = normalize_limit;

interface ShareMetaResp {
  share_name?: string | null;
  display_name?: string | null;
  title?: string | null;
}

/** 分享元信息取展示名：`share_name` 为主，缺失时回退 `display_name`/`title`。 */
export function resolve_share_name(resp: ShareMetaResp): string {
  const candidates = [resp.share_name, resp.display_name, resp.title];
  for (const c of candidates) {
    if (typeof c === "string") {
      const t = c.trim();
      if (t !== "") return t;
    }
  }
  return "未命名分享";
}
export const resolveShareName = resolve_share_name;

interface PreviewResp {
  video_preview_play_info?: { quick_video_list?: VideoPreview[] } | null;
  quick_video_list?: VideoPreview[];
}

/**
 * 从预览接口响应抽出转码档列表：优先内嵌 `video_preview_play_info.quick_video_list`
 *（2026-10-10 实测形状），为空时兼容顶层 `quick_video_list`。
 */
export function extract_quick_video_list(resp: PreviewResp): VideoPreview[] {
  const nested = resp.video_preview_play_info?.quick_video_list ?? [];
  if (nested.length > 0) return nested;
  return resp.quick_video_list ?? [];
}
export const extractQuickVideoList = extract_quick_video_list;

/**
 * 校验分享链接（直译 `store.rs::parse_share_url`）。
 * 仅接受 `www.alipan.com` / `aliyundrive.com` / `*.aliyundrive.com` 且路径以 `/s/` 开头。
 */
export function parse_share_url(raw: string): URL {
  const url = raw.trim();
  if (url === "") throw new Error("链接不能为空");
  const rest = url.startsWith("https://")
    ? url.slice("https://".length)
    : url.startsWith("http://")
      ? url.slice("http://".length)
      : null;
  if (rest === null) throw new Error("链接须以 http(s):// 开头");
  const hostEnd = (() => {
    const i = rest.search(/[/?#]/);
    return i === -1 ? rest.length : i;
  })();
  let host = rest.slice(0, hostEnd).toLowerCase();
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  const hostOk =
    host === "www.alipan.com" ||
    host === "aliyundrive.com" ||
    host.endsWith(".aliyundrive.com");
  if (!hostOk) throw new Error("仅支持 www.alipan.com 或 *.aliyundrive.com 分享链接");
  const afterHost = rest.slice(hostEnd);
  const pathEnd = (() => {
    const i = afterHost.search(/[?#]/);
    return i === -1 ? afterHost.length : i;
  })();
  if (!afterHost.slice(0, pathEnd).startsWith("/s/")) {
    throw new Error("链接路径须以 /s/ 开头");
  }
  try {
    return new URL(url);
  } catch {
    throw new Error("链接解析失败");
  }
}
export const parseShareUrl = parse_share_url;

/** 从分享 URL 提取 `/s/` 后第一段作为 share_id（直译 `store.rs::extract_share_id`）。 */
export function extract_share_id(url: URL | string): string {
  let path: string;
  if (typeof url === "string") {
    try {
      path = new URL(url).pathname;
    } catch {
      throw new Error("链接解析失败");
    }
  } else {
    path = url.pathname;
  }
  const rest = path.startsWith("/s/") ? path.slice("/s/".length) : null;
  if (rest === null) throw new Error("链接路径须以 /s/ 开头");
  const id = (rest.split("/")[0] ?? "").trim();
  if (id === "") throw new Error("链接中缺少 share_id");
  return id;
}
export const extractShareId = extract_share_id;

// ---------------------------------------------------------------------------
// ShareClient（直译 Rust `ShareClient` + 四个 Tauri command 的校验语义）
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  fetchedAt: number;
}

/**
 * 进程级 token 缓存（按 share_id+pwd），跨 `ShareClient` 实例复用。
 * 存 `fetchFn` 引用：仅同一 fetch 实现才命中，避免单测 mock 串扰。
 */
interface GlobalTokenEntry extends CachedToken {
  fetchFn: typeof fetch;
}

const globalTokenCache = new Map<string, GlobalTokenEntry>();

function tokenCacheKey(shareId: string, pwd?: string): string {
  return `${shareId}\n${pwd ?? ""}`;
}

/** 清空进程级 token 缓存（单测隔离用）。 */
export function clearShareTokenCache(): void {
  globalTokenCache.clear();
}
export const clear_share_token_cache = clearShareTokenCache;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 是否为限流错误（命中即退避重试一次）。 */
export function is_too_many_requests(err: unknown): boolean {
  return err instanceof ShareApiError && err.code === "TooManyRequests";
}
export const isTooManyRequests = is_too_many_requests;

interface TokenResp {
  share_token: string;
  expire_time?: string;
  expires_in?: number;
}

interface ListResp {
  items?: ShareItem[];
  next_marker?: string;
}

export class ShareClient {
  private readonly shareId: string;
  private readonly sharePwd?: string;
  private readonly fetchFn: typeof fetch;
  private cachedToken: CachedToken | null = null;

  constructor(shareId: string, pwd?: string, fetchFn?: typeof fetch) {
    this.shareId = shareId.trim();
    const p = pwd?.trim();
    this.sharePwd = p !== undefined && p !== "" ? p : undefined;
    this.fetchFn = fetchFn ?? fetch;
  }

  private anonymousHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      "User-Agent": USER_AGENT,
      "X-Canary": CANARY,
      "x-device-id": DEVICE_ID,
    };
  }

  private assertShareId(): void {
    if (this.shareId === "") throw new Error("share_id 不能为空");
  }

  private async refresh_share_token(): Promise<string> {
    const body: Record<string, unknown> = { share_id: this.shareId };
    if (this.sharePwd !== undefined) body["share_pwd"] = this.sharePwd;
    const url = `${PDS_ENDPOINT}/v2/share_link/get_share_token`;
    const resp = await this.post_anonymous<TokenResp>(url, body);
    const entry = { token: resp.share_token, fetchedAt: Date.now() };
    this.cachedToken = entry;
    globalTokenCache.set(tokenCacheKey(this.shareId, this.sharePwd), {
      ...entry,
      fetchFn: this.fetchFn,
    });
    return resp.share_token;
  }

  /**
   * 取 share_token：实例缓存 → 进程级缓存（同 fetch 实现）→ 网络。
   * 站方 expires_in 为 7200，此处 7000s 内命中缓存。
   */
  async shareToken(): Promise<string> {
    const cached = this.cachedToken;
    if (cached !== null && Date.now() - cached.fetchedAt < TOKEN_TTL_SECS * 1000) {
      return cached.token;
    }
    const global = globalTokenCache.get(tokenCacheKey(this.shareId, this.sharePwd));
    if (
      global !== undefined &&
      global.fetchFn === this.fetchFn &&
      Date.now() - global.fetchedAt < TOKEN_TTL_SECS * 1000
    ) {
      this.cachedToken = { token: global.token, fetchedAt: global.fetchedAt };
      return global.token;
    }
    return this.refresh_share_token();
  }

  private async post_anonymous<T>(url: string, body: unknown): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let resp: Response;
      try {
        resp = await this.fetchFn(url, {
          method: "POST",
          headers: this.anonymousHeaders(),
          body: JSON.stringify(body),
          signal:
            typeof AbortSignal.timeout === "function"
              ? AbortSignal.timeout(REQUEST_TIMEOUT_SECS * 1000)
              : undefined,
        });
      } catch (e) {
        if (e instanceof ShareApiError) throw e;
        throw transport_error(e);
      }
      try {
        return await parse_api_response<T>(resp);
      } catch (e) {
        if (is_too_many_requests(e) && attempt === 0) {
          await sleep(RATE_LIMIT_RETRY_MS);
          continue;
        }
        throw e;
      }
    }
    throw new Error("unreachable");
  }

  private async post_share_with<T>(url: string, body: unknown, token: string): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let resp: Response;
      try {
        resp = await this.fetchFn(url, {
          method: "POST",
          headers: { ...this.anonymousHeaders(), "x-share-token": token },
          body: JSON.stringify(body),
          signal:
            typeof AbortSignal.timeout === "function"
              ? AbortSignal.timeout(REQUEST_TIMEOUT_SECS * 1000)
              : undefined,
        });
      } catch (e) {
        if (e instanceof ShareApiError) throw e;
        throw transport_error(e);
      }
      try {
        return await parse_api_response<T>(resp);
      } catch (e) {
        if (is_too_many_requests(e) && attempt === 0) {
          await sleep(RATE_LIMIT_RETRY_MS);
          continue;
        }
        throw e;
      }
    }
    throw new Error("unreachable");
  }

  /** 带 share-token 的请求；token 失效时刷新一次并重试（对齐 alist 驱动）。 */
  private async post_share<T>(url: string, body: unknown): Promise<T> {
    const token = await this.shareToken();
    try {
      return await this.post_share_with<T>(url, body, token);
    } catch (e) {
      if (is_share_token_invalid(e)) {
        const fresh = await this.refresh_share_token();
        return this.post_share_with<T>(url, body, fresh);
      }
      throw e;
    }
  }

  /**
   * 单页列目录：无 marker 从头取，有 marker 续取；`next_marker` 为空即到底。
   * `limit` 越界收敛到 100，空 parent 视为 root。
   */
  async listShare(
    parentFileId: string,
    marker?: string,
    limit?: number,
  ): Promise<ListShareResult> {
    this.assertShareId();
    const parent = parentFileId.trim() === "" ? "root" : parentFileId.trim();
    const body: Record<string, unknown> = {
      share_id: this.shareId,
      parent_file_id: parent,
      limit: normalize_limit(limit),
      image_thumbnail_process: IMAGE_THUMBNAIL_PROCESS,
      image_url_process: IMAGE_URL_PROCESS,
      video_thumbnail_process: VIDEO_THUMBNAIL_PROCESS,
      order_by: "name",
      order_direction: "ASC",
    };
    const m = normalize_marker(marker);
    if (m !== undefined) body["marker"] = m;
    const url = `${PDS_ENDPOINT}/adrive/v2/file/list_by_share`;
    const page = await this.post_share<ListResp>(url, body);
    return { items: page.items ?? [], next_marker: page.next_marker ?? "" };
  }

  /**
   * 翻页拉全（设上限防异常循环）。分页浏览不需要它，仅保留给批量导出类场景。
   * 直译 Rust `list_all`（原 `#[allow(dead_code)]`）。
   */
  async listAll(parentFileId: string): Promise<ShareItem[]> {
    const out: ShareItem[] = [];
    let marker = "";
    for (let i = 0; i < LIST_MAX_PAGES; i++) {
      const page = await this.listShare(
        parentFileId,
        marker === "" ? undefined : marker,
      );
      out.push(...page.items);
      if (page.next_marker === "") break;
      marker = page.next_marker;
    }
    return out;
  }

  /** 取指定文件的转码预览档列表（只取 quick_video，不含字幕等附加字段）。 */
  async videoPreview(driveId: string, fileId: string): Promise<VideoPreview[]> {
    this.assertShareId();
    if (driveId.trim() === "" || fileId.trim() === "") {
      throw new Error("share_id/drive_id/file_id 均不能为空");
    }
    const body = {
      share_id: this.shareId,
      drive_id: driveId.trim(),
      file_id: fileId.trim(),
      category: "quick_video",
      template_id: "",
      get_preview_url: true,
      get_subtitle_info: true,
    };
    const url = `${PDS_ENDPOINT}/adrive/v2/file/get_video_preview_play_info_by_share`;
    const resp = await this.post_share<PreviewResp>(url, body);
    return extract_quick_video_list(resp);
  }

  /**
   * 取分享元信息（标题）。此接口不需要 x-share-token，用裸 post。
   * 浏览器实测为 v3 带 `?share_id=`（响应体与 v2 同形）。
   */
  async getShareByAnonymous(): Promise<ShareMeta> {
    this.assertShareId();
    const body: Record<string, unknown> = { share_id: this.shareId };
    if (this.sharePwd !== undefined) body["share_pwd"] = this.sharePwd;
    const url = `${PDS_ENDPOINT}/adrive/v3/share_link/get_share_by_anonymous?share_id=${encodeURIComponent(this.shareId)}`;
    const resp = await this.post_anonymous<ShareMetaResp>(url, body);
    return { name: resolve_share_name(resp) };
  }

  /** `get_share_meta` 命令语义：与 `getShareByAnonymous` 同义。 */
  async getShareMeta(): Promise<ShareMeta> {
    return this.getShareByAnonymous();
  }

  /** 按偏好取一档可用预览地址（`definition` 参数名供 Wave 3 接线，勿改）。 */
  async pickPreviewUrl(
    driveId: string,
    fileId: string,
    definition: Definition,
  ): Promise<PickPreviewResult> {
    this.assertShareId();
    if (driveId.trim() === "" || fileId.trim() === "") {
      throw new Error("share_id/drive_id/file_id 均不能为空");
    }
    const templates = await this.videoPreview(driveId.trim(), fileId.trim());
    const picked = pick_template(templates, definition);
    if (picked === undefined) {
      throw new Error(`没有可用的预览档（偏好 ${definition}）`);
    }
    const url = picked.preview_url;
    if (typeof url !== "string" || url === "") {
      throw new Error(`没有可用的预览档（偏好 ${definition}）`);
    }
    return { url, template: picked.template_id };
  }
}

// ---------------------------------------------------------------------------
// 自由函数：直译四个 Tauri command（含各自的参数校验），Wave 3 接线用。
// ---------------------------------------------------------------------------

/** 直译 `list_share` command：永远单页返回，空 parent 视为 root。 */
export async function list_share(
  shareId: string,
  parentFileId: string,
  marker?: string,
  limit?: number,
  pwd?: string,
): Promise<ListShareResult> {
  if (shareId.trim() === "") throw new Error("share_id 不能为空");
  const parent = parentFileId.trim() === "" ? "root" : parentFileId.trim();
  const client = new ShareClient(shareId.trim(), pwd);
  return client.listShare(parent, marker, limit);
}

/** 直译 `get_share_meta` command。 */
export async function get_share_meta(shareId: string, pwd?: string): Promise<ShareMeta> {
  if (shareId.trim() === "") throw new Error("share_id 不能为空");
  return new ShareClient(shareId.trim(), pwd).getShareByAnonymous();
}

/** 直译 `pick_preview_url` command。 */
export async function pick_preview_url(
  shareId: string,
  driveId: string,
  fileId: string,
  definition: string,
  pwd?: string,
): Promise<PickPreviewResult> {
  if (
    shareId.trim() === "" ||
    driveId.trim() === "" ||
    fileId.trim() === ""
  ) {
    throw new Error("share_id/drive_id/file_id 均不能为空");
  }
  const templates = await new ShareClient(shareId.trim(), pwd).videoPreview(
    driveId.trim(),
    fileId.trim(),
  );
  const picked = pick_template(templates, definition);
  if (picked === undefined) {
    throw new Error(`没有可用的预览档（偏好 ${definition}）`);
  }
  const url = picked.preview_url;
  if (typeof url !== "string" || url === "") {
    throw new Error(`没有可用的预览档（偏好 ${definition}）`);
  }
  return { url, template: picked.template_id };
}

/**
 * 直译 `video_preview` command。
 * 注意：原 command 固定传 `None` 作 pwd（不带提取码），此处逐字保留。
 */
export async function video_preview(
  shareId: string,
  driveId: string,
  fileId: string,
): Promise<VideoPreview[]> {
  if (
    shareId.trim() === "" ||
    driveId.trim() === "" ||
    fileId.trim() === ""
  ) {
    throw new Error("share_id/drive_id/file_id 均不能为空");
  }
  return new ShareClient(shareId.trim()).videoPreview(
    driveId.trim(),
    fileId.trim(),
  );
}
