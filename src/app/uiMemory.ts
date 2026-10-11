/**
 * 界面状态记忆：分类折叠 + 右侧打开的合集，存 localStorage。
 * 只做“读”的纯函数（写在组件内 try/catch，风格同 siderWidth）。
 * 右侧只恢复到合集根目录，不恢复深层浏览栈/选中文件（链接可能过期）。
 */

export const OPEN_KEYS_KEY = "fastcut.openKeys";
export const ACTIVE_COLLECTION_KEY = "fastcut.activeCollectionId";

/**
 * 读回折叠状态：JSON 字符串数组；缺失/非法一律回 null（= 全部展开）。
 * 空数组合法（= 全部折叠）。
 */
export function loadOpenKeys(read: () => string | null): string[] | null {
  try {
    const raw = read();
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((k): k is string => typeof k === "string");
  } catch {
    return null;
  }
}

/** 读回上次打开的合集 id：非空字符串才有效。 */
export function loadActiveCollectionId(read: () => string | null): string | null {
  try {
    const raw = read();
    if (raw === null || raw.trim() === "") {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}
