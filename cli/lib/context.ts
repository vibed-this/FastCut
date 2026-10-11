/**
 * CLI 共享类型。
 *
 * 退出码：0 成功、1 用法错误、2 业务失败。
 */

/** 子命令运行时的共享上下文（全局 flag 解析后下发）。 */
export interface CliContext {
  userDataDir: string;
  targetDirOverride?: string;
  json: boolean;
  verbose: boolean;
}

/** 子命令返回的统一结果（由入口渲染后 `process.exit(code)`）。 */
export interface CliResult {
  code: 0 | 1 | 2;
  human: string;
  data?: unknown;
  error?: string;
  errorCode?: string;
}

/** 子命令契约：registry 按此形状静态聚合。 */
export interface CliCommand {
  name: string;
  describe: string;
  usage: string;
  run(ctx: CliContext, argv: string[]): Promise<CliResult>;
}
