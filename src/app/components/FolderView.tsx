/** 文件夹浏览：面包屑 + 缩略图网格。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp, Badge, Breadcrumb, Button, Space, Spin, Typography } from "antd";
import { FileOutlined, FolderFilled, VideoCameraOutlined } from "@ant-design/icons";
import { getStatusBatch, listShare } from "../api";
import type { FileStatus, ShareItem } from "../api";
import { useStore } from "../store";
import VideoPane from "./VideoPane";

/** 文件夹视图属性。 */
export interface FolderViewProps {
  /** 所属页签 id。 */
  tabId: string;
}

/** 单页条数：与后端上限 100 对齐。 */
const PAGE_SIZE = 100;

/** 是否为视频文件。 */
function isVideoFile(item: ShareItem): boolean {
  if (item.type === "folder") {
    return false;
  }
  if (item.category === "video") {
    return true;
  }
  const ext = (item.file_extension ?? "").toLowerCase();
  return ["mp4", "mkv", "mov", "m3u8", "avi", "webm"].includes(ext);
}

/** 格式化文件大小。 */
function formatSize(size?: number): string {
  if (size === undefined || size === null) {
    return "-";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = size;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * 文件夹视图。
 *
 * @param props - 组件属性
 * @returns 文件夹浏览元素
 */
export default function FolderView(props: FolderViewProps): React.JSX.Element {
  const { tabId } = props;
  const { state, dispatch } = useStore();
  const { message } = AntdApp.useApp();
  const tab = state.tabs.find((t) => t.id === tabId);
  const [items, setItems] = useState<ShareItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextMarker, setNextMarker] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, FileStatus>>({});

  /** 把一批条目的状态并入映射（只查新增 id）。 */
  async function mergeStatuses(shareId: string, batch: ShareItem[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }
    const statuses = await getStatusBatch(
      shareId,
      batch.map((i) => i.file_id),
    );
    setStatusMap((prev) => {
      const map = { ...prev };
      for (const s of statuses) {
        map[s.file_id] = s;
      }
      return map;
    });
  }

  const stackKey = useMemo(
    () => (tab === undefined ? "" : tab.stack.map((s) => s.file_id).join("/")),
    [tab],
  );
  const progressKey = useMemo(
    () => (tab?.progress === undefined ? "" : Object.keys(tab.progress).sort().join(",")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab?.progress],
  );

  const load = useCallback(async () => {
    if (tab === undefined) {
      return;
    }
    const current = tab.stack[tab.stack.length - 1];
    if (current === undefined) {
      return;
    }
    setLoading(true);
    try {
      // 首屏只取一页，大目录靠“加载更多”续取，避免一次拉全卡死。
      const res = await listShare(tab.share_id, current.file_id, undefined, PAGE_SIZE);
      setItems(res.items);
      setNextMarker(res.next_marker === "" ? null : res.next_marker);
      setStatusMap({});
      await mergeStatuses(tab.share_id, res.items);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, stackKey]);

  /** 用 next_marker 续取下一页并追加。 */
  async function loadMore(): Promise<void> {
    if (tab === undefined || nextMarker === null || loadingMore) {
      return;
    }
    const current = tab.stack[tab.stack.length - 1];
    if (current === undefined) {
      return;
    }
    setLoadingMore(true);
    try {
      const res = await listShare(tab.share_id, current.file_id, nextMarker, PAGE_SIZE);
      setItems((prev) => [...prev, ...res.items]);
      setNextMarker(res.next_marker === "" ? null : res.next_marker);
      await mergeStatuses(tab.share_id, res.items);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void load();
    // 挂载与 stack 变化时刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, stackKey]);

  // 下载进度变化后刷新该 tab 状态（含完成清空后终查一次，落"已保存"角标）；
  // 用 ref 跳过挂载首跑（load 已查过），key 未变（纯 done/total 推进）不重查。
  const prevProgressKey = useRef("");
  useEffect(() => {
    if (tab === undefined || items.length === 0) {
      return;
    }
    if (progressKey === prevProgressKey.current) {
      return;
    }
    prevProgressKey.current = progressKey;
    let cancelled = false;
    void getStatusBatch(
      tab.share_id,
      items.map((i) => i.file_id),
    )
      .then((statuses) => {
        if (!cancelled) {
          const map: Record<string, FileStatus> = {};
          for (const s of statuses) {
            map[s.file_id] = s;
          }
          setStatusMap(map);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          void message.error(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressKey]);

  if (tab === undefined) {
    return <Typography.Text type="secondary">页签不存在</Typography.Text>;
  }
  /** 收窄后的当前页签（闭包内直接用，避免 TS18048）。 */
  const currentTab = tab;

  /** 进入文件夹。 */
  function enterFolder(item: ShareItem): void {
    dispatch({ type: "tabs/push", tabId, entry: { file_id: item.file_id, name: item.name } });
  }

  /** 选中视频文件并触发右侧预览。 */
  function previewFile(item: ShareItem): void {
    dispatch({ type: "tabs/select", tabId, file: item });
  }

  /** 文件夹排前面，其余保持接口返回顺序（资源管理器式）。 */
  const sortedItems = useMemo(
    () =>
      [...items].sort((a, b) => {
        const af = a.type === "folder" ? 0 : 1;
        const bf = b.type === "folder" ? 0 : 1;
        return af - bf;
      }),
    [items],
  );

  /** 状态角标：已保存 / 下载中。 */
  function statusBadge(item: ShareItem): React.JSX.Element | null {
    const st = statusMap[item.file_id];
    const prog = currentTab.progress?.[item.file_id];
    if (prog !== undefined) {
      const pct = prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;
      return <Badge status="processing" text={`下载中 ${pct}%`} />;
    }
    if (st === undefined || st.state === "none") {
      return null;
    }
    if (st.state === "saved") {
      return <Badge status="success" text="已保存" />;
    }
    return <Badge status="processing" text="下载中" />;
  }

  /** 单个缩略图磁贴。 */
  function renderTile(item: ShareItem): React.JSX.Element {
    const isFolder = item.type === "folder";
    const previewable = isFolder || isVideoFile(item);
    const selected = currentTab.selected_file?.file_id === item.file_id;
    const icon = isFolder ? (
      <FolderFilled style={{ fontSize: 56, color: "#f5c542" }} />
    ) : isVideoFile(item) ? (
      <VideoCameraOutlined style={{ fontSize: 52, color: "#666" }} />
    ) : (
      <FileOutlined style={{ fontSize: 52, color: "#999" }} />
    );
    return (
      <div
        data-testid={isFolder ? "enter-folder" : "preview-file"}
        title={previewable ? undefined : "暂不支持预览"}
        onClick={() => {
          if (isFolder) {
            enterFolder(item);
          } else if (isVideoFile(item)) {
            previewFile(item);
          }
        }}
        onDoubleClick={() => {
          if (isFolder) {
            enterFolder(item);
          }
        }}
        style={{
          width: 132,
          padding: "12px 8px 8px",
          borderRadius: 8,
          border: selected ? "1px solid #1677ff" : "1px solid transparent",
          background: selected ? "#e6f4ff" : undefined,
          cursor: previewable ? "pointer" : "default",
          opacity: previewable ? 1 : 0.55,
          textAlign: "center",
        }}
        onMouseEnter={(e) => {
          if (previewable && !selected) {
            e.currentTarget.style.background = "#f5f5f5";
          }
        }}
        onMouseLeave={(e) => {
          if (!selected) {
            e.currentTarget.style.background = "";
          }
        }}
      >
        <div style={{ height: 64, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {icon}
        </div>
        <Typography.Paragraph
          ellipsis={{ rows: 2, tooltip: item.name }}
          style={{ fontSize: 12, margin: "8px 0 2px", minHeight: 32, lineHeight: "16px" }}
        >
          {item.name}
        </Typography.Paragraph>
        <div style={{ fontSize: 11, color: "#999", minHeight: 16 }}>
          {isFolder ? "文件夹" : formatSize(item.size)}
        </div>
        <div style={{ minHeight: 18 }}>{statusBadge(item)}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Breadcrumb
            items={tab.stack.map((s, idx) => ({
              key: `${s.file_id}-${idx}`,
              title:
                idx === tab.stack.length - 1 ? (
                  <span>{s.name}</span>
                ) : (
                  <Button
                    type="link"
                    style={{ padding: 0, height: "auto" }}
                    onClick={() => {
                      dispatch({
                        type: "tabs/navigate",
                        tabId,
                        stack: tab.stack.slice(0, idx + 1),
                      });
                    }}
                  >
                    {s.name}
                  </Button>
                ),
            }))}
          />
          <Spin spinning={loading} tip="加载中…">
            {sortedItems.length === 0 && !loading ? (
              <Typography.Text type="secondary">空文件夹</Typography.Text>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignContent: "flex-start" }}>
                {sortedItems.map((item) => (
                  <div key={item.file_id}>{renderTile(item)}</div>
                ))}
              </div>
            )}
          </Spin>
          <div style={{ display: "flex", justifyContent: "center" }}>
            {nextMarker !== null ? (
              <Button
                data-testid="load-more"
                loading={loadingMore}
                onClick={() => void loadMore()}
              >
                加载更多（已加载 {items.length} 项）
              </Button>
            ) : (
              items.length > 0 && (
                <Typography.Text type="secondary">已加载全部 {items.length} 项</Typography.Text>
              )
            )}
          </div>
        </Space>
      </div>
      {tab.selected_file !== undefined ? (
        <div style={{ width: 480, flexShrink: 0 }}>
          <VideoPane tabId={tabId} />
        </div>
      ) : null}
    </div>
  );
}
