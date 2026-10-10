# FastCut 详细设计：阿里云盘分享页视频增强工具

> 范围：单个视频「打开后自动播放」+「下载按钮（预览流转 MP4 自动存指定文件夹）」+「页内已保存状态展示」。技术栈：Tauri。
> 约定：提交信息遵循 Conventional Commits；设计/代码分离提交；密钥与构建产物不入库。

## 1. 背景与已验证事实

分享页 `https://www.alipan.com/s/<share_id>/folder/<file_id>` 为 React 17 SPA（`aliyun-drive/6.2.3-share`）。

1. 列表页无 `<video>`，只有缩略图；单击选中，双击/点播放键在匿名态弹登录框，登录态直接开预览抽屉。
2. 预览取流接口（页面自用，已在匿名与登录态双验证）：
   `POST /adrive/v2/file/get_video_preview_play_info_by_share`
   `{share_id, drive_id, file_id, category:"quick_video", template_id, get_preview_url:true}` + `x-share-token`
   → `quick_video_list[].{template_id: SD|HD, preview_url: <m3u8>}`，m3u8 host 为 `cn-beijing-video-preview.aliyundrive.net`。
3. 流格式已验证：VOD、无 `EXT-X-KEY`、分片为 MPEG-TS（首字节 `0x47`）；页面上下文 fetch m3u8/ts 无 CORS 问题；签名约 2h 有效（`x-oss-expires`），须现取现用。
4. 站方播放器：`<video src="blob:...">`（MSE/hls.js），`autoplay=false`，打开后暂停态；静音下 `video.play()` 可放行。
5. 原文件直下不可行：`get_download_url` 调分享盘文件报 403，须先存到个人盘。故下载统一走预览流。
6. 登录 token 位于页面 `localStorage.token`；分享 token 位于 `localStorage.shareToken`（JWT，`expires_in 7200`）。
7. 工具链坑（已踩过）：Chrome 136+ 的 `--remote-debugging-port` 必须配非默认 `--user-data-dir`；本机 shell 有 `7897` 代理，localhost 请求须 bypass。

## 2. 总体架构

```
┌ Tauri App ───────────────────────────────────────────┐
│ 主窗口（本地启动器 UI）                               │
│  └ 输入/粘贴分享链接 → open_share → 开预览窗口        │
│ 预览窗口（远端 alipan 分享页）                        │
│  └ 注入 JS：自动播放 / 下载按钮+状态 / 取流 URL        │──invoke──▶ Rust 后端
│      ▲ progress/done 事件回推                          │◀─events──  下载ts→拼接→ffmpeg remux→写盘→记账
│ 预览窗口数据目录独立（沿用 --user-data-dir 副本思路，   │
│ 不碰用户本机 Chrome 原 Profile）                       │
│ ffmpeg 走系统安装（启动自检，缺失则引导用户安装）       │
└──────────────────────────────────────────────────────┘
```

职责划分：JS 只做页面增强与取 URL（复用页面登录态与 shareToken，不在 Rust 侧复刻鉴权）；Rust 只做二进制下载、转封装、文件写盘与记账。

## 3. 功能设计

### F1 打开后自动播放

- 注入脚本监听预览 `<video>` 出现；先 `muted=true` 再 `play()`，播起来后尝试恢复用户原音量偏好（`ADRIVE_VIDEO_PREFERENCE_DEFINITION` 可读）。
- 优先点播放器自身的播放按钮（与 React 状态机一致），DOM `play()` 为兜底。
- 有声自动播放被拦截时保持静音播放并 toast 提示点一下开声。

### F2 下载按钮（预览流 → MP4 → 指定文件夹）

- 落点：页面右下角悬浮按钮（fixed，不进 React 树；原“清晰度旁”方案不可行——toolbar 闲置时卸载且 React 调和会删外挂节点）。下载档位跟随当前清晰度（高清→HD m3u8，标清→SD），退出预览时按钮自动移除。
- 管线：
  1. JS 调 play_info 取对应档 `preview_url`（点下载瞬间现取），传 `{m3u8_url, file_id, file_name}` 给 Rust。
  2. Rust 解析 m3u8（非 `#` 行为分片，相对路径按 m3u8 base 拼接，保留签名 query）→ 并发（默认 4）拉 ts → 按序拼接。
  3. 喂给 ffmpeg sidecar：`ffmpeg -i pipe:0 -c copy <name>.mp4`（仅 remux，不重编码）。
  4. 写到配置的目标文件夹；文件名=原文件名换 `.mp4`，冲突加 ` (n)` 后缀。
  5. 写记账：`{file_id, share_id, template, path, size, saved_at}`。
- 进度事件 `download-progress {file_id, done, total}` 驱动按钮态（下载中 %）；完成/失败推 `download-done`。
- 边界：m3u8 出现 `EXT-X-KEY` 则中止并提示（当前文件无加密，先只做 citest 断言）；签名过期（4xx）→ 回调 JS 重取 URL 后续传；ffmpeg 缺失 → 启动自检并提示。

### F3 页内已保存状态展示

- 数据源：Rust 记账 store（`file_id → {path, saved_at}`），文件不存在则视为未保存（启动/进入预览时校验一次）。
- 展示：预览标题旁徽标（已保存 ✓ + 路径 tooltip / 下载中 % / 未下载）；列表页行级标记为二期（需把 `list_by_share` 的 file_id 与行 DOM 对应，单独做）。
- 同一 `file_id` 不同清晰度视为同一文件（记账键只用 `share_id:file_id`）。

### F4 配置

- 目标文件夹（Tauri dialog 选择，持久化到 store）。
- 默认清晰度（跟随页面选择 / 固定 HD / 固定 SD）。
- 文件名模板（默认原文件名；预留 `{date}` 等变量，二期）。

## 4. Rust 命令与事件

- `open_share {url} → {window_label}`：校验 `https://www.alipan.com/s/...`（兼容 aliyundrive.com 同路径分享链接）格式后创建/复用预览窗口并载入；非法 URL 直接报错。
- `get_config / set_config / pick_folder`
- `get_status {share_id, file_id} → {state: saved|downloading|none, path?}`
- `download_video {m3u8_url, share_id, file_id, file_name, template}`（幂等：已在下发的返回现有任务）
- 事件：`download-progress`, `download-done {ok, path|error}`

## 5. 非功能与风险

- macOS 分发需签名公证；ffmpeg 依赖系统安装（启动时跑 `ffmpeg -version` 自检，缺失则引导用户安装），只做 `-c copy` remux，不重编码。
- macOS webview 为 WKWebView：hls.js 可播，但自动播放策略与 Chrome 有差异，以真机实测为准。
- 站方改版（bundle 路径、接口字段）是最大风险：JS 按“能力探测”（元素/API 存在性）写，不硬编码类名哈希；play_info 调不通时按钮置灰并提示。
- token/shareToken 只活在 webview 内存与页面 storage，不写入应用日志与仓库（Git 规范：密钥不入库）。

## 6. 里程碑

- M1：Tauri 脚手架 + 启动器 UI + 预览窗口 + 注入脚本（自动播放）。
- M2：下载管线（Rust 拉 ts + ffmpeg remux + 存盘 + 进度）。
- M3：记账 + 状态展示 + 配置页。
- M4：打包（mac 先行）、回归清单（匿名/登录、SD/HD、长视频多分片、签名过期）。

## 7. 待确认（已决议）

1. ffmpeg 来源：走系统安装；启动时自检，缺失则提示安装。
2. 重编码：不需要，仅 remux（`-c copy`）。
3. 目标文件夹不存在时自动创建（含中间目录）；不可写则报错并提示。
