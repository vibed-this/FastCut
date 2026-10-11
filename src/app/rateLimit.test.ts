import { describe, expect, it, vi } from "vitest";
import { isRateLimitError, withRateLimitRetry } from "./rateLimit";

const BLOCK_EX = "接口错误（BlockException）：rule:TooManyRequests";

describe("isRateLimitError", () => {
  it("识别两种限流文案", () => {
    expect(isRateLimitError(new Error(BLOCK_EX))).toBe(true);
    expect(isRateLimitError(new Error("接口错误（TooManyRequests）：too many"))).toBe(true);
  });
  it("非限流错误不误判", () => {
    expect(isRateLimitError(new Error("接口错误（NotFound）：无此分享"))).toBe(false);
    expect(isRateLimitError(new Error("网络错误：timeout"))).toBe(false);
  });
});

describe("withRateLimitRetry", () => {
  it("一次成功不等待", async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => "ok");
    await expect(withRateLimitRetry(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("限流则退避一次后成功", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error(BLOCK_EX);
      return "ok";
    });
    await expect(withRateLimitRetry(fn, { sleep, delayMs: 6000 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(6000);
  });
  it("非限流错误直接透出、不重试", async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => {
      throw new Error("接口错误（NotFound）：无此分享");
    });
    await expect(withRateLimitRetry(fn, { sleep })).rejects.toThrow("NotFound");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("重试耗尽后抛最后一次错误", async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => {
      throw new Error(BLOCK_EX);
    });
    await expect(withRateLimitRetry(fn, { sleep, retries: 2 })).rejects.toThrow("BlockException");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
