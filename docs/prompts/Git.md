# Git 规范

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED",  "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 覆盖规则

总体提交格式依照 Conventional Commits。**严格 MUST**按照如下顺序覆盖：

用户提示词要求 > 本规范要求 > Conventional Commits 要求

## 提交信息格式

- 提交标题**必须 MUST**为 `` `<type>(<scope>): <简述>` `` 或 `` `<type>: <简述>` ``，`type` **必须 MUST**取自 `feat/fix/docs/refactor/perf/test/build/ci/chore/deps/revert`，而不是自造词。
- `scope` **可 MAY**省略，写时**必须 MUST**小写 kebab-case 并指向模块或目录，而不是人名或日期。
- 简述**应当 SHOULD**使用中文，英文仓**可 MAY**全仓统一用英文祈使句，而不是中英混杂。
- 标题**必须 MUST**不超过 50 字且不加句末标点，破坏性变更**必须 MUST**在正文或页脚标注 `BREAKING CHANGE:`。
- 正文**应当 SHOULD**说明动机与影响范围，**禁止 MUST NOT**在 body 里复述标题已写过的变更。

## 提交粒度

- 每次提交**必须 MUST**只含一个逻辑变更，保持精益，而不是捆绑多主题。
- 跨层变更（如前后端）**应当 SHOULD**按层拆分提交，而不是混入同一提交。
- 分支名**推荐 RECOMMENDED**用 `main` 加 `feat/<scope>` 形式，发布标签**可 MAY**用 `vX.Y.Z`。
- 纯文档、重命名、格式调整**必须 MUST**与功能代码分开提交，而不是混入同一提交。

## Agent 操作边界

- 除非用户显式要求执行写入操作，否则 **禁止 MUST NOT**执行 `add/commit/push/pull/merge/rebase/reset/checkout（写模式）/tag/branch` 等副作用命令。
- `status/log/diff/show` 等只读操作**可 MAY**直接执行。
- 提交前**必须 MUST**检查 `status/diff/log` 并只暂存预期文件，而不是全量暂存。
- 提交身份、远端、认证用户切换**必须 MUST**事先确认，而不是擅自切换。

## 忽略与安全

- 依赖目录与构建产物**禁止 MUST NOT**入库，如 `node_modules/dist/build/.venv`，而应在 `.gitignore` 声明。
- 令牌、密钥、数据库文件、隧道凭证**禁止 MUST NOT**提交。
- 大体积二进制与可再生中间产物**禁止 MUST NOT**入库，如 `*.apk/jadx_out/.deob`，文档中**可 MAY**只保留相对路径指针，而不是嵌入正文。
