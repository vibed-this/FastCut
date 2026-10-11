import {
  createContext,
  useContext,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type { Collection, CollectionKind, ShareItem } from "./api";

// ---- State ----

export interface StackEntry {
  /** alipan 下为远端 file_id；xiaohongshu 下即 relPath（根为合集 relDir）。语义保留。 */
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

/** 浏览文件：云盘条目原样；小红书本地文件经合成（absPath 为本地绝对路径）。 */
export type ExplorerFile = ShareItem & { absPath?: string };

/** 右侧单合集浏览状态（原多页签 Tab，已去页签化：同时只看一个合集）。 */
export interface Explorer {
  collection_id: string;
  collection_name: string;
  kind: CollectionKind;
  stack: StackEntry[];
  selected_file?: ExplorerFile;
  /** hover 命中的文件（空格预览的目标，不等同于选中）。 */
  hovered_file?: ExplorerFile;
  /** 空格预览中的文件（Quick Look 弹窗，无标题栏/下载按钮）。 */
  preview_file?: ExplorerFile;
  /** 双击打开的文件（完整播放器：半透明遮罩 + 标题栏 + 下载）。 */
  opened_file?: ExplorerFile;
  video?: ExplorerVideo;
  progress?: Record<string, ExplorerProgress>;
}

export interface AppState {
  collections: Collection[];
  /** 当前打开的合集 id，无打开时为 null。 */
  activeCollectionId: string | null;
  /** 当前浏览状态，无打开合集时为 null。 */
  explorer: Explorer | null;
  /** 素材目录：UI 侧会与 null 比较，故类型放宽，初始值仍为 ""。 */
  materialDir: string | null;
  globalError: string | null;
}

export const initialState: AppState = {
  collections: [],
  activeCollectionId: null,
  explorer: null,
  materialDir: "",
  globalError: null,
};

// ---- Action ----

export type Action =
  | { type: "collections/set"; collections: Collection[] }
  | { type: "collections/add"; collection: Collection }
  | { type: "collections/rename"; collection_id: string; name: string }
  | { type: "collections/remove"; collection_id: string }
  | { type: "material/set"; dir: string }
  | { type: "error/set"; message: string | null }
  | { type: "explorer/open"; collection: Collection }
  | { type: "explorer/close" }
  | { type: "explorer/navigate"; stack: StackEntry[] }
  | { type: "explorer/push"; entry: StackEntry }
  | { type: "explorer/pop" }
  | { type: "explorer/select"; file?: ExplorerFile }
  | { type: "explorer/hover"; file?: ExplorerFile }
  | { type: "explorer/preview"; file?: ExplorerFile }
  | { type: "explorer/openFile"; file?: ExplorerFile }
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
    case "collections/set":
      return { ...state, collections: action.collections };
    case "collections/add": {
      const exists = state.collections.some(
        (s) => s.collection_id === action.collection.collection_id,
      );
      return {
        ...state,
        collections: exists
          ? state.collections.map((s) =>
              s.collection_id === action.collection.collection_id ? action.collection : s,
            )
          : [...state.collections, action.collection],
      };
    }
    case "collections/rename":
      return {
        ...state,
        collections: state.collections.map((s) =>
          s.collection_id === action.collection_id ? { ...s, name: action.name } : s,
        ),
        explorer:
          state.explorer !== null && state.explorer.collection_id === action.collection_id
            ? { ...state.explorer, collection_name: action.name }
            : state.explorer,
      };
    case "collections/remove": {
      const collections = state.collections.filter(
        (s) => s.collection_id !== action.collection_id,
      );
      const closingCurrent =
        state.explorer !== null && state.explorer.collection_id === action.collection_id;
      return {
        ...state,
        collections,
        activeCollectionId: closingCurrent ? null : state.activeCollectionId,
        explorer: closingCurrent ? null : state.explorer,
      };
    }
    case "material/set":
      return { ...state, materialDir: action.dir };
    case "error/set":
      return { ...state, globalError: action.message };
    case "explorer/open": {
      // alipan 根 file_id 约定为 "root"；xiaohongshu 根为合集 relDir（相对 target_dir 的完整路径）。
      const isXhs = action.collection.kind === "xiaohongshu";
      const rootId = isXhs ? (action.collection.relDir ?? "") : "root";
      return {
        ...state,
        activeCollectionId: action.collection.collection_id,
        explorer: {
          collection_id: action.collection.collection_id,
          collection_name: action.collection.name,
          kind: action.collection.kind,
          stack: [{ file_id: rootId, name: "合集根目录" }],
        },
      };
    }
    case "explorer/close":
      return { ...state, activeCollectionId: null, explorer: null };
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
