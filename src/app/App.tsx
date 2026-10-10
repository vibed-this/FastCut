/** 应用入口：浅色布局与全局初始化。 */
import { useEffect } from "react";
import { Alert, App as AntdApp, Layout } from "antd";
import { getConfig, listShares } from "./api";
import { useStore } from "./store";
import Sidebar from "./components/Sidebar";
import TabsView from "./components/TabsView";

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
        const [shares, cfg] = await Promise.all([listShares(), getConfig()]);
        if (cancelled) {
          return;
        }
        dispatch({ type: "shares/set", shares });
        dispatch({ type: "material/set", dir: cfg.target_dir ?? "" });
        dispatch({ type: "definition/set", definition: cfg.definition });
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
          <TabsView />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
