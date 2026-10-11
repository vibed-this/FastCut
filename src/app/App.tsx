/** 应用入口：浅色布局与全局初始化。 */
import { useEffect } from "react";
import { Alert, App as AntdApp, Empty, Layout } from "antd";
import { getConfig, listCollections } from "./api";
import { useStore } from "./store";
import Sidebar from "./components/Sidebar";
import FolderView from "./components/FolderView";
import { isVideoFile } from "./components/FolderView";
import { playerControl } from "./components/VideoPane";

/**
 * 应用根组件（需在上层的 StoreProvider 与 antd App/ConfigProvider 内渲染）。
 *
 * @returns 应用布局元素
 */
export default function App(): React.JSX.Element {
  const { state, dispatch } = useStore();
  const { message } = AntdApp.useApp();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [collections, cfg] = await Promise.all([listCollections(), getConfig()]);
        if (cancelled) {
          return;
        }
        dispatch({ type: "collections/set", collections });
        dispatch({ type: "material/set", dir: cfg.target_dir ?? "" });
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
        <Layout.Sider width={280} theme="light" style={{ overflowY: "auto", background: "#fff" }}>
          <Sidebar />
        </Layout.Sider>
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
