/** 左侧边栏宽度：拖拽调整 + localStorage 记忆。DOM 无关，可单测。 */

export const SIDER_WIDTH_KEY = "fastcut.sidebarWidth";
export const DEFAULT_SIDER_WIDTH = 280;
export const MIN_SIDER_WIDTH = 200;
export const MAX_SIDER_WIDTH = 520;

/** 将任意数值钳制到 [MIN, MAX]；非法输入回默认值。 */
export function clampSiderWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SIDER_WIDTH;
  }
  return Math.min(MAX_SIDER_WIDTH, Math.max(MIN_SIDER_WIDTH, Math.round(value)));
}

/**
 * 从存储读回宽度。read 注入 localStorage.getItem 便于单测；
 * 缺失/非法/抛错一律回默认值。
 */
export function loadSiderWidth(read: () => string | null): number {
  try {
    const raw = read();
    if (raw === null) {
      return DEFAULT_SIDER_WIDTH;
    }
    return clampSiderWidth(Number(raw));
  } catch {
    return DEFAULT_SIDER_WIDTH;
  }
}
