/**
 * 站方瞬时限流（TooManyRequests / BlockException）退避重试。
 * 主进程已有一次 1s 重试；此处再给一次更长的退避（e2e 走查验证过 6s 有效），
 * 覆盖列表首屏与翻页，瞬时限流不再直接红错。
 * 只读列表类幂等调用用它，写操作不要用。
 */

/** 文案里是否携带限流信号（主进程透出的中文文案原样包含 rule 名）。 */
export function isRateLimitError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes("TooManyRequests");
}

export interface RateLimitRetryOpts {
  /** 限流时额外重试次数（默认 1）。 */
  retries?: number;
  /** 每次退避等待毫秒（默认 6000）。 */
  delayMs?: number;
  /** 注入等待函数，便于单测。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 限流则退避重试，非限流错误直接透出；重试耗尽后抛最后一次错误。 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts?: RateLimitRetryOpts,
): Promise<T> {
  const retries = opts?.retries ?? 1;
  const delayMs = opts?.delayMs ?? 6000;
  const sleep = opts?.sleep ?? defaultSleep;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt < retries && isRateLimitError(e)) {
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
  throw last;
}
