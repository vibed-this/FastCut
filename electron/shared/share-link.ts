/**
 * 剪贴板分享链接检测（纯函数，无 node / electron 依赖，renderer 可直接 import）。
 *
 * - 按出现顺序取第一个可识别链接：alipan 分享（host 白名单 + `/s/` 路径）或
 *   小红书（xiaohongshu.com / xhslink.com，含子域名）；
 * - alipan 额外从全文搜 `提取码[:：]xxxx`（4 位），有则一并带回；
 * - 粘贴文本常带中文标点/括号包裹，抽 URL 后清掉尾随标点。
 */

export type DetectedShareLink =
  | { kind: "alipan"; url: string; pwd?: string }
  | { kind: "xiaohongshu"; url: string };

const URL_RE = /https?:\/\/[^\s<>"'（）()[\]]+/g;

/** URL 尾随标点（粘贴 `xxx。，）` 这类时误吸入的半角/全角符号）。 */
const TRAIL_PUNCT_RE = /[.,;:!?~。，、；：！？～）)】」"']+$/;

function cleanUrl(raw: string): string {
  return raw.replace(TRAIL_PUNCT_RE, "");
}

function hostOf(u: URL): string {
  let host = u.hostname.toLowerCase();
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  return host;
}

function isAlipanUrl(u: URL): boolean {
  const host = hostOf(u);
  const hostOk =
    host === "www.alipan.com" || host === "aliyundrive.com" || host.endsWith(".aliyundrive.com");
  if (!hostOk) return false;
  if (!u.pathname.startsWith("/s/")) return false;
  const id = (u.pathname.slice("/s/".length).split("/")[0] ?? "").trim();
  return id !== "";
}

function isXhsUrl(u: URL): boolean {
  const host = hostOf(u);
  return (
    host === "xiaohongshu.com" ||
    host.endsWith(".xiaohongshu.com") ||
    host === "xhslink.com" ||
    host.endsWith(".xhslink.com")
  );
}

/** 从全文搜提取码（`提取码：abcd` / `密码: abcd` / `pwd=abcd`，4 位字母数字）。 */
export function extractPwd(text: string): string | undefined {
  const m = /(?:提取码|提取密码|访问密码|密码|pwd|code)\s*[:：=]\s*([A-Za-z0-9]{4})/i.exec(text);
  const code = (m?.[1] ?? "").trim();
  return code === "" ? undefined : code;
}

/**
 * 检测文本中的分享链接，无匹配返回 null。
 * alipan 与小红书同时出现时取先出现的那个。
 */
export function detectShareLink(text: string): DetectedShareLink | null {
  if (text.trim() === "") return null;
  const candidates = text.match(URL_RE) ?? [];
  for (const raw of candidates) {
    const url = cleanUrl(raw);
    if (url === "") continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (isAlipanUrl(parsed)) {
      const pwd = extractPwd(text);
      return pwd === undefined ? { kind: "alipan", url } : { kind: "alipan", url, pwd };
    }
    if (isXhsUrl(parsed)) {
      return { kind: "xiaohongshu", url };
    }
  }
  return null;
}
