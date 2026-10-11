/**
 * 本地媒体协议 URL 构造（main / renderer 共用）。
 *
 * `media://file<绝对路径>` → 主进程 `protocol.handle("media")` 直出文件流。
 * 路径必须按段编码：`encodeURI` 会放过 `#`/`?`，含这些字符的文件名
 * （如小红书标题 `#话题`）会被浏览器截断为 fragment，播出来就是
 * “不支持的音频/视频格式”。此处逐段 `encodeURIComponent` 再用 `/` 拼接，
 * `/` 本身保持原样，`file://` 侧能正确解回。
 */

/** 绝对路径 → `media://file…` URL（与主进程协议处理器配对）。 */
export function toLocalMediaUrl(absPath: string): string {
  return `media://file${absPath.split("/").map(encodeURIComponent).join("/")}`;
}
