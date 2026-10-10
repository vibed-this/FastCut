/** 多分享页签容器。 */
import { App as AntdApp, Empty, Tabs } from "antd";
import { useStore } from "../store";
import FolderView from "./FolderView";

/** 页签容器属性。 */
export interface TabsViewProps {
  /** 预留扩展，无必填项。 */
  className?: string;
}

/**
 * 分享页签视图。
 *
 * @param props - 组件属性
 * @returns 页签元素
 */
export default function TabsView(props: TabsViewProps): React.JSX.Element {
  const { className } = props;
  const { state, dispatch } = useStore();
  const { message } = AntdApp.useApp();

  if (state.tabs.length === 0) {
    return (
      <div className={className} style={{ padding: 48, display: "flex", justifyContent: "center" }}>
        <Empty description="暂无打开的分享，请从左侧添加并打开" />
      </div>
    );
  }

  return (
    <Tabs
      className={className}
      type="editable-card"
      hideAdd
      activeKey={state.activeTabId ?? undefined}
      style={{ height: "100%" }}
      onChange={(key) => {
        dispatch({ type: "tabs/switch", tabId: key });
      }}
      onEdit={(targetKey, action) => {
        // 关闭页签：VideoPane 随卸载销毁 hls 实例，此处只需清 store
        if (action === "remove") {
          const tabId = String(targetKey);
          try {
            dispatch({ type: "tabs/remove", tabId });
          } catch (e) {
            void message.error(e instanceof Error ? e.message : String(e));
          }
        }
      }}
      items={state.tabs.map((tab) => ({
        key: tab.id,
        label: <span data-testid="tab-title">{tab.share_name}</span>,
        closable: true,
        children: <FolderView tabId={tab.id} />,
      }))}
    />
  );
}
