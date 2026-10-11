import {
  createContext,
  useContext,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type { SavedShare, ShareItem } from "./api";

// ---- State ----

export interface StackEntry {
  file_id: string;
  name: string;
}

export interface ExplorerVideo {
  url: string;
  template: string;
}

export interface ExplorerProgress {
  done: number;
  total: number;
}

/** 右侧单分享浏览状态（原多页签 Tab，已去页签化：同时只看一个分享）。 */
export interface Explorer {
  share_id: string;
  share_name: string;
  stack: StackEntry[];
  selected_file?: ShareItem;
  /** hover 命中的文件（空格预览的目标，不等同于选中）。 */
  hovered_file?: ShareItem;
  /** 空格预览中的文件（Quick Look 弹窗，无标题栏/下载按钮）。 */
  preview_file?: ShareItem;
  /** 双击打开的文件（完整播放器：半透明遮罩 + 标题栏 + 下载）。 */
  opened_file?: ShareItem;
  video?: ExplorerVideo;
  progress?: Record<string, ExplorerProgress>;
}

export interface AppState {
  shares: SavedShare[];
  /** 当前打开的分享 id，无打开时为 null。 */
  activeShareId: string | null;
  /** 当前浏览状态，无打开分享时为 null。 */
  explorer: Explorer | null;
  /** 素材目录：UI 侧会与 null 比较，故类型放宽，初始值仍为 ""。 */
  materialDir: string | null;
  globalError: string | null;
}

export const initialState: AppState = {
  shares: [],
  activeShareId: null,
  explorer: null,
  materialDir: "",
  globalError: null,
};

// ---- Action ----

export type Action =
  | { type: "shares/set"; shares: SavedShare[] }
  | { type: "shares/add"; share: SavedShare }
  | { type: "shares/rename"; share_id: string; name: string }
  | { type: "shares/remove"; share_id: string }
  | { type: "material/set"; dir: string }
  | { type: "error/set"; message: string | null }
  | { type: "explorer/open"; share: SavedShare }
  | { type: "explorer/close" }
  | { type: "explorer/navigate"; stack: StackEntry[] }
  | { type: "explorer/push"; entry: StackEntry }
  | { type: "explorer/pop" }
  | { type: "explorer/select"; file?: ShareItem }
  | { type: "explorer/hover"; file?: ShareItem }
  | { type: "explorer/preview"; file?: ShareItem }
  | { type: "explorer/openFile"; file?: ShareItem }
  | { type: "explorer/video"; video?: ExplorerVideo }
  | {
      type: "explorer/progress";
      file_id: string;
      progress: ExplorerProgress;
    }
  | { type: "explorer/setProgress"; fileId: string; done: number; total: number }
  | { type: "explorer/progressClear"; file_id: string }
  | { type: "explorer/clearProgress"; fileId: string };

function mapExplorer(state: AppState, fn: (e: Explorer) => Explorer): AppState {
  if (state.explorer === null) return state;
  return { ...state, explorer: fn(state.explorer) };
}

function setProgress(
  state: AppState,
  fileId: string,
  progress: ExplorerProgress,
): AppState {
  return mapExplorer(state, (e) => ({
    ...e,
    progress: { ...e.progress, [fileId]: progress },
  }));
}

function clearProgress(state: AppState, fileId: string): AppState {
  return mapExplorer(state, (e) => {
    if (!e.progress) return e;
    const progress = { ...e.progress };
    delete progress[fileId];
    return { ...e, progress };
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
        explorer:
          state.explorer !== null && state.explorer.share_id === action.share_id
            ? { ...state.explorer, share_name: action.name }
            : state.explorer,
      };
    case "shares/remove": {
      const shares = state.shares.filter((s) => s.share_id !== action.share_id);
      const closingCurrent =
        state.explorer !== null && state.explorer.share_id === action.share_id;
      return {
        ...state,
        shares,
        activeShareId: closingCurrent ? null : state.activeShareId,
        explorer: closingCurrent ? null : state.explorer,
      };
    }
    case "material/set":
      return { ...state, materialDir: action.dir };
    case "error/set":
      return { ...state, globalError: action.message };
    case "explorer/open": {
      // 根目录 file_id 约定为 "root"，stack[0] 即根。
      return {
        ...state,
        activeShareId: action.share.share_id,
        explorer: {
          share_id: action.share.share_id,
          share_name: action.share.name,
          stack: [{ file_id: "root", name: "分享根目录" }],
        },
      };
    }
    case "explorer/close":
      return { ...state, activeShareId: null, explorer: null };
    case "explorer/navigate":
      return mapExplorer(state, (e) => ({ ...e, stack: action.stack, hovered_file: undefined }));
    case "explorer/push":
      return mapExplorer(state, (e) => ({
        ...e,
        stack: [...e.stack, action.entry],
        hovered_file: undefined,
      }));
    case "explorer/pop":
      return mapExplorer(state, (e) => ({
        ...e,
        stack: e.stack.slice(0, -1),
      }));
    case "explorer/select":
      return mapExplorer(state, (e) => ({
        ...e,
        selected_file: action.file,
      }));
    case "explorer/hover":
      return mapExplorer(state, (e) => ({
        ...e,
        hovered_file: action.file,
      }));
    case "explorer/preview":
      return mapExplorer(state, (e) => ({
        ...e,
        preview_file: action.file,
      }));
    case "explorer/openFile":
      return mapExplorer(state, (e) => ({
        ...e,
        // 双击打开完整播放器时关掉空格预览，两者不叠加。
        preview_file: undefined,
        opened_file: action.file,
      }));
    case "explorer/video":
      return mapExplorer(state, (e) => ({
        ...e,
        video: action.video,
      }));
    case "explorer/progress":
      return setProgress(state, action.file_id, action.progress);
    case "explorer/setProgress":
      return setProgress(state, action.fileId, {
        done: action.done,
        total: action.total,
      });
    case "explorer/progressClear":
      return clearProgress(state, action.file_id);
    case "explorer/clearProgress":
      return clearProgress(state, action.fileId);
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
