@docs/prompts/*.md

# CLI（给 agent 用）

独立 Node CLI，不启动 Electron，直接复用 `electron/main` 纯逻辑。
`preview` 相关不进 CLI；`electron/main/index.ts` 不可被 CLI 引用。

- 构建运行：`npm run build:cli` → `out/cli/fastcut-cli.js`（已忽略，不入库），
  用 `node out/cli/fastcut-cli.js <命令>` 调用。
- 命令：`collection <list|add|rename|remove>`、`import <xhs|alipan|<分享链接>>`。
  加新命令只在 `cli/commands/` 加文件并在 `registry.ts` 注册一行。
- 全局 flag（须放命令之前）：`--user-data-dir`、`--target-dir`、`--json`、
  `--verbose`、`--help`；环境变量 `FASTCUT_USER_DATA_DIR` / `FASTCUT_TARGET_DIR`
  次优先；缺省读应用配置（userData 下 `fastcut.json`）。
- 输出协议：默认 stdout 人类可读行；`--json` 时 stdout 仅一个
  `{"ok",...}`，进度一律走 stderr。退出码 0 成功、1 用法错误、2 业务失败。
- 约束：`--dry-run` 不落盘；带签名的 preview_url 不得进 stdout；
  `--target-dir` 经环境变量桥进 downloader/store，应用内行为不变。
- 校验：`npx tsc --noEmit`、`npx vitest run` 全过才能提交。