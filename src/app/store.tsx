import {
  createContext,
  useContext,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type { Definition, SavedShare, ShareItem } from "./api";

// ---- State ----

export interface StackEntry {
  file_id: string;
  name: string;
}

export interface TabVideo {
  url: string;
  template: string;
}

export interface TabProgress {
  done: number;
  total: number;
}

export interface Tab {
  id: string;
  share_id: string;
  share_name: string;
  stack: StackEntry[];
  selected_file?: ShareItem;
  /** 空格预览中的文件（Quick Look 弹窗，无标题栏/下载按钮）。 */
  preview_file?: ShareItem;
  /** 双击打开的文件（完整播放器：半透明遮罩 + 标题栏 + 下载）。 */
  opened_file?: ShareItem;
  video?: TabVideo;
  progress?: Record<string, TabProgress>;
}

export interface AppState {
  shares: SavedShare[];
  tabs: Tab[];
  activeTabId: string | null;
  /** 素材目录：UI 侧会与 null 比较，故类型放宽，初始值仍为 ""。 */
  materialDir: string | null;
  definition: Definition;
  globalError: string | null;
}

export const initialState: AppState = {
  shares: [],
  tabs: [],
  activeTabId: null,
  materialDir: "",
  definition: "AUTO",
  globalError: null,
};

// ---- Action（基建主契约 + UI 侧别名，两套同义，reducer 统一处理）----

export type Action =
  | { type: "shares/set"; shares: SavedShare[] }
  | { type: "shares/add"; share: SavedShare }
  | { type: "shares/rename"; share_id: string; name: string }
  | { type: "shares/remove"; share_id: string }
  | { type: "material/set"; dir: string }
  | { type: "definition/set"; definition: Definition }
  | { type: "config/set"; materialDir: string | null; definition: string }
  | { type: "error/set"; message: string | null }
  | { type: "tabs/add"; tab: Tab }
  | { type: "tabs/open"; share: SavedShare }
  | { type: "tabs/remove"; tabId: string }
  | { type: "tabs/close"; tabId: string }
  | { type: "tabs/switch"; tabId: string | null }
  | { type: "tabs/activate"; tabId: string }
  | { type: "tabs/navigate"; tabId: string; stack: StackEntry[] }
  | { type: "tabs/setStack"; tabId: string; stack: StackEntry[] }
  | { type: "tabs/push"; tabId: string; entry: StackEntry }
  | { type: "tabs/pop"; tabId: string }
  | { type: "tabs/select"; tabId: string; file?: ShareItem }
  | { type: "tabs/selectFile"; tabId: string; file?: ShareItem }
  | { type: "tabs/preview"; tabId: string; file?: ShareItem }
  | { type: "tabs/openFile"; tabId: string; file?: ShareItem }
  | { type: "tabs/video"; tabId: string; video?: TabVideo }
  | {
      type: "tabs/progress";
      tabId: string;
      file_id: string;
      progress: TabProgress;
    }
  | { type: "tabs/setProgress"; tabId: string; fileId: string; done: number; total: number }
  | { type: "tabs/progressClear"; tabId: string; file_id: string }
  | { type: "tabs/clearProgress"; tabId: string; fileId: string };

function mapTab(state: AppState, tabId: string, fn: (t: Tab) => Tab): AppState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === tabId ? fn(t) : t)),
  };
}

function setProgress(
  state: AppState,
  tabId: string,
  fileId: string,
  progress: TabProgress,
): AppState {
  return mapTab(state, tabId, (t) => ({
    ...t,
    progress: { ...t.progress, [fileId]: progress },
  }));
}

function clearProgress(state: AppState, tabId: string, fileId: string): AppState {
  return mapTab(state, tabId, (t) => {
    if (!t.progress) return t;
    const progress = { ...t.progress };
    delete progress[fileId];
    return { ...t, progress };
  });
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "shares/set":
      return { ...state, shares: action.shares };
    case "shares/add": {
      const exists = state.shares.some((s) => s.share_id === action.share.share_id);
      return {
        ...state,
        shares: exists
          ? state.shares.map((s) =>
              s.share_id === action.share.share_id ? action.share : s,
            )
          : [...state.shares, action.share],
      };
    }
    case "shares/rename":
      return {
        ...state,
        shares: state.shares.map((s) =>
          s.share_id === action.share_id ? { ...s, name: action.name } : s,
        ),
        tabs: state.tabs.map((t) =>
          t.share_id === action.share_id
            ? { ...t, share_name: action.name }
            : t,
        ),
      };
    case "shares/remove": {
      const tabs = state.tabs.filter((t) => t.share_id !== action.share_id);
      return {
        ...state,
        shares: state.shares.filter((s) => s.share_id !== action.share_id),
        tabs,
        activeTabId:
          state.activeTabId !== null &&
          !tabs.some((t) => t.id === state.activeTabId)
            ? (tabs[tabs.length - 1]?.id ?? null)
            : state.activeTabId,
      };
    }
    case "material/set":
      return { ...state, materialDir: action.dir };
    case "definition/set":
      return { ...state, definition: action.definition };
    case "config/set":
      return {
        ...state,
        materialDir: action.materialDir,
        definition: action.definition as Definition,
      };
    case "error/set":
      return { ...state, globalError: action.message };
    case "tabs/add": {
      const exists = state.tabs.some((t) => t.id === action.tab.id);
      const tabs = exists
        ? state.tabs.map((t) => (t.id === action.tab.id ? action.tab : t))
        : [...state.tabs, action.tab];
      return { ...state, tabs, activeTabId: action.tab.id };
    }
    case "tabs/open": {
      // 根目录 file_id 约定为 "root"（待后端确认），stack[0] 即根。
      const tab: Tab = {
        id: action.share.share_id,
        share_id: action.share.share_id,
        share_name: action.share.name,
        stack: [{ file_id: "root", name: action.share.name }],
      };
      const exists = state.tabs.some((t) => t.id === tab.id);
      const tabs = exists
        ? state.tabs.map((t) => (t.id === tab.id ? { ...t, share_name: tab.share_name } : t))
        : [...state.tabs, tab];
      return { ...state, tabs, activeTabId: tab.id };
    }
    case "tabs/remove":
    case "tabs/close": {
      const tabs = state.tabs.filter((t) => t.id !== action.tabId);
      const activeTabId =
        state.activeTabId === action.tabId
          ? (tabs[tabs.length - 1]?.id ?? null)
          : state.activeTabId;
      return { ...state, tabs, activeTabId };
    }
    case "tabs/switch":
    case "tabs/activate":
      return { ...state, activeTabId: action.tabId };
    case "tabs/navigate":
    case "tabs/setStack":
      return mapTab(state, action.tabId, (t) => ({
        ...t,
        stack: action.stack,
      }));
    case "tabs/push":
      return mapTab(state, action.tabId, (t) => ({
        ...t,
        stack: [...t.stack, action.entry],
      }));
    case "tabs/pop":
      return mapTab(state, action.tabId, (t) => ({
        ...t,
        stack: t.stack.slice(0, -1),
      }));
    case "tabs/select":
    case "tabs/selectFile":
      return mapTab(state, action.tabId, (t) => ({
        ...t,
        selected_file: action.file,
      }));
    case "tabs/preview":
      return mapTab(state, action.tabId, (t) => ({
        ...t,
        preview_file: action.file,
      }));
    case "tabs/openFile":
      return mapTab(state, action.tabId, (t) => ({
        ...t,
        // 双击打开完整播放器时关掉空格预览，两者不叠加。
        preview_file: undefined,
        opened_file: action.file,
      }));
    case "tabs/video":
      return mapTab(state, action.tabId, (t) => ({
        ...t,
        video: action.video,
      }));
    case "tabs/progress":
      return setProgress(state, action.tabId, action.file_id, action.progress);
    case "tabs/setProgress":
      return setProgress(state, action.tabId, action.fileId, {
        done: action.done,
        total: action.total,
      });
    case "tabs/progressClear":
      return clearProgress(state, action.tabId, action.file_id);
    case "tabs/clearProgress":
      return clearProgress(state, action.tabId, action.fileId);
  }
}

// ---- Context ----

interface StoreValue {
  state: AppState;
  dispatch: Dispatch<Action>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      {children}
    </StoreContext.Provider>
  );
}

function useStoreInternal(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}

export const useStore: () => StoreValue = useStoreInternal;
/** UI 侧别名：与 useStore 同构。 */
export const useApp: () => StoreValue = useStoreInternal;
