/** 应用入口：浅色布局与全局初始化。 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Alert, App as AntdApp, Empty, Layout } from "antd";
import { getConfig, getSidebarOrders, listCollections } from "./api";
import { useStore } from "./store";
import Sidebar from "./components/Sidebar";
import FolderView from "./components/FolderView";
import { isVideoFile } from "./components/FolderView";
import { playerControl } from "./components/VideoPane";
import {
  DEFAULT_SIDER_WIDTH,
  SIDER_WIDTH_KEY,
  clampSiderWidth,
  loadSiderWidth,
} from "./siderWidth";
import { ACTIVE_COLLECTION_KEY, loadActiveCollectionId } from "./uiMemory";

/**
 * 应用根组件（需在上层的 StoreProvider 与 antd App/ConfigProvider 内渲染）。
 *
 * @returns 应用布局元素
 */
export default function App(): React.JSX.Element {
  const { state, dispatch } = useStore();
  const { message } = AntdApp.useApp();

  // 右侧打开的合集 id 记忆：activeIdRef 供启动恢复时判断用户是否已手动打开；
  // restoredRef 保证恢复完成前不写记忆（挂载瞬间 id 为初始 null，直接写会清掉上次记录）。
  const activeCollectionId = state.activeCollectionId;
  const activeIdRef = useRef<string | null>(activeCollectionId);
  activeIdRef.current = activeCollectionId;
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!restoredRef.current || typeof localStorage === "undefined") {
      return;
    }
    try {
      if (activeCollectionId === null) {
        localStorage.removeItem(ACTIVE_COLLECTION_KEY);
      } else {
        localStorage.setItem(ACTIVE_COLLECTION_KEY, activeCollectionId);
      }
    } catch {
      // 存储不可用时忽略，下次回到空状态。
    }
  }, [activeCollectionId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [collections, cfg, sidebarOrders] = await Promise.all([
          listCollections(),
          getConfig(),
          getSidebarOrders().catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        dispatch({ type: "collections/set", collections });
        dispatch({ type: "material/set", dir: cfg.target_dir ?? "" });
        if (sidebarOrders !== null) {
          dispatch({
            type: "sidebar/orders",
            category_order: sidebarOrders.category_order,
            collection_orders: sidebarOrders.collection_orders,
          });
        }
        // 恢复上次打开的合集（仅当它还在列表里；回到根目录，不恢复深层浏览栈）。
        // 若加载期间用户已手动打开（activeIdRef 非空），以用户的选择为准，不覆盖。
        if (activeIdRef.current === null && typeof localStorage !== "undefined") {
          const lastId = loadActiveCollectionId(() => localStorage.getItem(ACTIVE_COLLECTION_KEY));
          const target = lastId === null ? undefined : collections.find((c) => c.collection_id === lastId);
          if (target !== undefined) {
            dispatch({ type: "explorer/open", collection: target });
          }
        }
        restoredRef.current = true;
      } catch (e) {
        if (!cancelled) {
          void message.error(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emptyMaterial = state.materialDir === "";
  const explorer = state.explorer;

  // 左侧栏宽度：可拖拽调整，记忆到 localStorage。
  const [siderWidth, setSiderWidth] = useState<number>(() =>
    typeof localStorage === "undefined"
      ? DEFAULT_SIDER_WIDTH
      : loadSiderWidth(() => localStorage.getItem(SIDER_WIDTH_KEY)),
  );
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(siderWidth);
  widthRef.current = siderWidth;

  function persistSiderWidth(width: number): void {
    try {
      localStorage.setItem(SIDER_WIDTH_KEY, String(width));
    } catch {
      // 存储不可用（如隐私模式）时忽略，下次回默认值。
    }
  }

  function beginResize(e: ReactMouseEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    setResizing(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent): void => {
      if (ev.buttons === 0) {
        // 在窗口外松开：收不到 mouseup，靠 buttons 识别收尾。
        onUp();
        return;
      }
      setSiderWidth(clampSiderWidth(startWidth + (ev.clientX - startX)));
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setResizing(false);
      persistSiderWidth(widthRef.current);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  }

  function resetSiderWidth(): void {
    setSiderWidth(DEFAULT_SIDER_WIDTH);
    try {
      localStorage.removeItem(SIDER_WIDTH_KEY);
    } catch {
      // 忽略，见 persistSiderWidth。
    }
  }

  // 全局空格（Quick Look 语义）：预览开着→关闭；完整播放器开着→播放/暂停；
  // 否则 hover 视频→空格预览（无 hover 时回退选中）。输入框/按钮聚焦时不劫持，保证空格正常输入与点击。
  const hasExplorer = explorer !== null;
  const previewFileId = explorer?.preview_file?.file_id ?? null;
  const openedFileId = explorer?.opened_file?.file_id ?? null;
  const hoveredFile = explorer?.hovered_file;
  const selectedFile = explorer?.selected_file;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || e.repeat) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target !== null && target.closest("input,textarea,select,[contenteditable='true'],button")) {
        return;
      }
      if (!hasExplorer) {
        return;
      }
      if (previewFileId !== null) {
        e.preventDefault();
        dispatch({ type: "explorer/preview", file: undefined });
        return;
      }
      if (openedFileId !== null) {
        if (playerControl.toggle !== null) {
          e.preventDefault();
          playerControl.toggle();
        }
        return;
      }
      // hover 优先：鼠标/键盘焦点所在的视频；无 hover 时回退选中（兼容无鼠标场景）。
      const previewTarget = hoveredFile !== undefined && isVideoFile(hoveredFile) ? hoveredFile : selectedFile;
      if (previewTarget !== undefined && isVideoFile(previewTarget)) {
        e.preventDefault();
        dispatch({ type: "explorer/preview", file: previewTarget });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, hasExplorer, previewFileId, openedFileId, hoveredFile, selectedFile]);

  return (
    <Layout style={{ height: "100vh" }}>
      <Layout>
        <div style={{ width: siderWidth, flex: `0 0 ${siderWidth}px`, display: "flex", position: "relative" }}>
          <style>{`.sider-resize-handle:hover,.sider-resize-handle.resizing,.sider-resize-handle:focus-visible{background:rgba(22,119,255,.3)}`}</style>
          <Layout.Sider
            width={siderWidth}
            theme="light"
            style={{ overflowY: "auto", background: "#fff", height: "100%" }}
          >
            <Sidebar />
          </Layout.Sider>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            title="拖动调整宽度，双击恢复默认"
            tabIndex={0}
            className={resizing ? "sider-resize-handle resizing" : "sider-resize-handle"}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: -5,
              width: 10,
              cursor: "col-resize",
              touchAction: "none",
              outlineOffset: -2,
              zIndex: 10,
            }}
            onMouseDown={beginResize}
            onDoubleClick={resetSiderWidth}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
                return;
              }
              e.preventDefault();
              const next = clampSiderWidth(siderWidth + (e.key === "ArrowRight" ? 10 : -10));
              setSiderWidth(next);
              persistSiderWidth(next);
            }}
          />
        </div>
        <Layout.Content style={{ padding: 16, overflowY: "auto" }}>
          {emptyMaterial ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="请先在左侧边栏配置素材文件夹后再保存视频"
            />
          ) : null}
          {explorer === null ? (
            <div style={{ padding: 48, display: "flex", justifyContent: "center" }}>
              <Empty description="暂无打开的合集，请从左侧选择" />
            </div>
          ) : (
            <FolderView />
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
