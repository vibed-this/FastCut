/** 文件夹浏览：面包屑 + 缩略图网格（缩略图用 list_by_share 自带 thumbnail，命中本地磁盘缓存秒显，禁止逐项调 preview）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp, Breadcrumb, Button, Space, Spin, Typography } from "antd";
import { CheckCircleFilled, FileOutlined, FolderFilled, VideoCameraOutlined } from "@ant-design/icons";
import { getStatusBatch, listShare, onDownloadDone, onDownloadProgress, warmThumbnails } from "../api";
import type { FileStatus, ShareItem } from "../api";
import { useStore } from "../store";
import VideoPane, { autoDownloadSilentIds } from "./VideoPane";

/** 文件夹视图属性。 */
export interface FolderViewProps {
  /** 预留扩展，无必填项。 */
  className?: string;
}

/** 单页条数：与后端上限 100 对齐。 */
const PAGE_SIZE = 100;

/** 是否为视频文件（App 层空格预览共用）。 */
export function isVideoFile(item: ShareItem): boolean {
  if (item.type === "folder") {
    return false;
  }
  if (item.category === "video") {
    return true;
  }
  const ext = (item.file_extension ?? "").toLowerCase();
  return ["mp4", "mkv", "mov", "m3u8", "avi", "webm"].includes(ext);
}

/**
 * 服务端快照图：加载中灰底骨架占位（含图标），载入后淡入；失败回退默认图标。
 *
 * @param props - 图片属性
 * @returns 缩略图元素
 */
function ThumbImage(props: { src: string; name: string; video: boolean }): React.JSX.Element {
  const { src, name, video } = props;
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [src]);
  const placeholderIcon = video ? (
    <VideoCameraOutlined style={{ fontSize: 40, color: "#bfbfbf" }} />
  ) : (
    <FileOutlined style={{ fontSize: 40, color: "#bfbfbf" }} />
  );
  if (failed) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f0f0f0",
        }}
      >
        {placeholderIcon}
      </div>
    );
  }
  return (
    // 1:1 正方形容器，图片 contain 完整显示（原始比例，黑边填充不裁切）。
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
      {!loaded ? (
        <div
          data-testid="thumb-placeholder"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#f0f0f0",
          }}
        >
          {placeholderIcon}
        </div>
      ) : null}
      <img
        src={src}
        alt={name}
        loading="lazy"
        referrerPolicy="no-referrer"
        onLoad={() => {
          setLoaded(true);
        }}
        onError={() => {
          setFailed(true);
        }}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
          opacity: loaded ? 1 : 0,
          transition: "opacity 0.25s ease-in",
        }}
      />
    </div>
  );
}

/**
 * 文件夹视图。
 *
 * @param props - 组件属性
 * @returns 文件夹浏览元素
 */
export default function FolderView(props: FolderViewProps): React.JSX.Element {
  const { className } = props;
  const { state, dispatch } = useStore();
  const { message } = AntdApp.useApp();
  const explorer = state.explorer;
  const [items, setItems] = useState<ShareItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextMarker, setNextMarker] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, FileStatus>>({});
  /** 缩略图本地缓存：fileId → media:// 本地 URL；命中即秒显，不阻塞远程首绘。 */
  const [thumbLocalMap, setThumbLocalMap] = useState<Record<string, string>>({});

  /** 后台预取一批缩略图（fire-and-forget：失败回退远程 URL，不弹错）。 */
  function warmBatch(shareId: string, batch: ShareItem[]): void {
    const entries = batch
      .filter((i) => i.thumbnail !== undefined && i.thumbnail !== "")
      .map((i) => ({ fileId: i.file_id, url: i.thumbnail as string }));
    if (entries.length === 0) {
      return;
    }
    warmThumbnails(shareId, entries)
      .then((cached) => {
        setThumbLocalMap((prev) => ({ ...prev, ...cached }));
      })
      .catch(() => undefined);
  }

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
    () => (explorer === undefined || explorer === null ? "" : explorer.stack.map((s) => s.file_id).join("/")),
    [explorer],
  );
  const progressKey = useMemo(
    () => (explorer?.progress === undefined ? "" : Object.keys(explorer.progress).sort().join(",")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [explorer?.progress],
  );

  const load = useCallback(async () => {
    if (explorer === undefined || explorer === null) {
      return;
    }
    const current = explorer.stack[explorer.stack.length - 1];
    if (current === undefined) {
      return;
    }
    setLoading(true);
    try {
      // 首屏只取一页，大目录靠“加载更多”续取，避免一次拉全卡死。
      const res = await listShare(explorer.share_id, current.file_id, undefined, PAGE_SIZE);
      setItems(res.items);
      setNextMarker(res.next_marker === "" ? null : res.next_marker);
      setStatusMap({});
      await mergeStatuses(explorer.share_id, res.items);
      warmBatch(explorer.share_id, res.items);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorer?.share_id, stackKey]);

  /** 用 next_marker 续取下一页并追加（loadingMore/到底 guard 防重复请求）。 */
  const loadMore = useCallback(async (): Promise<void> => {
    if (explorer === undefined || explorer === null || nextMarker === null || loadingMore || loading) {
      return;
    }
    const current = explorer.stack[explorer.stack.length - 1];
    if (current === undefined) {
      return;
    }
    setLoadingMore(true);
    try {
      const res = await listShare(explorer.share_id, current.file_id, nextMarker, PAGE_SIZE);
      setItems((prev) => [...prev, ...res.items]);
      setNextMarker(res.next_marker === "" ? null : res.next_marker);
      await mergeStatuses(explorer.share_id, res.items);
      warmBatch(explorer.share_id, res.items);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorer?.share_id, stackKey, nextMarker, loadingMore, loading]);

  /** 列表底部 sentinel：进入视口时自动触发下一页（含防抖 + loading guard）。 */
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const lastAutoLoadAt = useRef(0);
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null || nextMarker === null) {
      return;
    }
    // 非浏览器/测试环境无 IntersectionObserver 时不自动触发，保留手动按钮。
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry === undefined || !entry.isIntersecting) {
          return;
        }
        // 防抖：300ms 内重复进入视口只触发一次；loading guard 由 loadMore 内部保证。
        const now = Date.now();
        if (now - lastAutoLoadAt.current < 300) {
          return;
        }
        lastAutoLoadAt.current = now;
        void loadMore();
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [loadMore, nextMarker, explorer?.share_id, stackKey]);

  useEffect(() => {
    void load();
    // 挂载与 stack 变化时刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorer?.share_id, stackKey]);

  // 下载进度/完成订阅（单视图一份：open/预览触发的下载都推进度；
  // 自动下载的完成 toast 静默，手动保存仍提示；progress 变化驱动下方状态重查，磁贴绿勾自动出现）。
  useEffect(() => {
    let offProgress: (() => void) | null = null;
    let offDone: (() => void) | null = null;
    let cancelled = false;
    void onDownloadProgress((p) => {
      dispatch({
        type: "explorer/progress",
        file_id: p.file_id,
        progress: { done: p.done, total: p.total },
      });
    }).then((off) => {
      if (cancelled) {
        off();
      } else {
        offProgress = off;
      }
    });
    void onDownloadDone((d) => {
      dispatch({ type: "explorer/progressClear", file_id: d.file_id });
      const silent = autoDownloadSilentIds.has(d.file_id);
      autoDownloadSilentIds.delete(d.file_id);
      if (!d.ok) {
        void message.error(d.error ?? "下载失败");
      } else if (!silent) {
        void message.success("下载完成");
      }
    }).then((off) => {
      if (cancelled) {
        off();
      } else {
        offDone = off;
      }
    });
    return () => {
      cancelled = true;
      offProgress?.();
      offDone?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 下载进度变化后刷新当前分享状态（含完成清空后终查一次，落"已保存"角标）；
  // 用 ref 跳过挂载首跑（load 已查过），key 未变（纯 done/total 推进）不重查。
  const prevProgressKey = useRef("");
  useEffect(() => {
    if (explorer === undefined || explorer === null || items.length === 0) {
      return;
    }
    if (progressKey === prevProgressKey.current) {
      return;
    }
    prevProgressKey.current = progressKey;
    let cancelled = false;
    void getStatusBatch(
      explorer.share_id,
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

  if (explorer === undefined || explorer === null) {
    return <Typography.Text type="secondary">暂无打开的分享，请从左侧选择</Typography.Text>;
  }
  /** 收窄后的当前浏览（闭包内直接用，避免 TS18048）。 */
  const currentExplorer = explorer;

  /** 进入文件夹。 */
  function enterFolder(item: ShareItem): void {
    dispatch({ type: "explorer/push", entry: { file_id: item.file_id, name: item.name } });
  }

  /** 选中视频文件（仅高亮，不打开）。 */
  function selectFile(item: ShareItem): void {
    dispatch({ type: "explorer/select", file: item });
  }

  /** 双击打开完整播放器（选中 + 半透明遮罩 + 标题栏 + 下载）。 */
  function openFile(item: ShareItem): void {
    dispatch({ type: "explorer/select", file: item });
    dispatch({ type: "explorer/openFile", file: item });
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

  /** 单个缩略图磁贴（图片/视频均用服务端 thumbnail 快照，无则回退图标）。 */
  function renderTile(item: ShareItem): React.JSX.Element {
    const isFolder = item.type === "folder";
    const previewable = isFolder || isVideoFile(item);
    const selected = currentExplorer.selected_file?.file_id === item.file_id;
    const st = statusMap[item.file_id];
    const savedMark =
      !isFolder && st?.state === "saved" && currentExplorer.progress?.[item.file_id] === undefined ? (
        <span
          data-testid="saved-mark"
          title="已保存"
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            zIndex: 1,
            lineHeight: 0,
            filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
          }}
        >
          <CheckCircleFilled style={{ fontSize: 20, color: "#52c41a" }} />
        </span>
      ) : null;
    const cover = isFolder ? (
      <FolderFilled style={{ fontSize: 56, color: "#f5c542" }} />
    ) : item.thumbnail !== undefined && item.thumbnail !== "" ? (
      // 本地缓存命中秒显（media://），未命中先绘远程 URL，后台下完自动切换
      <ThumbImage src={thumbLocalMap[item.file_id] ?? item.thumbnail} name={item.name} video={isVideoFile(item)} />
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
            selectFile(item);
          }
        }}
        onDoubleClick={() => {
          if (isFolder) {
            enterFolder(item);
          } else if (isVideoFile(item)) {
            openFile(item);
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
        <div
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "1 / 1",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            borderRadius: 6,
          }}
        >
          {savedMark}
          {cover}
        </div>
        <Typography.Paragraph
          ellipsis={{ rows: 2, tooltip: item.name }}
          style={{ fontSize: 12, margin: "8px 0 2px", minHeight: 32, lineHeight: "16px" }}
        >
          {item.name}
        </Typography.Paragraph>
      </div>
    );
  }

  return (
    <div className={className} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <div data-testid="explorer-breadcrumb">
            <Breadcrumb
              items={explorer.stack.map((s, idx) => ({
                key: `${s.file_id}-${idx}`,
                title:
                  idx === explorer.stack.length - 1 ? (
                    <span>{s.name}</span>
                  ) : (
                    <Button
                      type="link"
                      style={{ padding: 0, height: "auto" }}
                      onClick={() => {
                        dispatch({
                          type: "explorer/navigate",
                          stack: explorer.stack.slice(0, idx + 1),
                        });
                      }}
                    >
                      {s.name}
                    </Button>
                  ),
              }))}
            />
          </div>
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
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            {/* 滚动自动加载 sentinel：进入视口即触发 loadMore */}
            <div ref={sentinelRef} data-testid="load-more-sentinel" style={{ height: 1, width: "100%" }} />
            {nextMarker !== null ? (
              loadingMore ? (
                <Spin size="small" tip={`加载更多中…（已加载 ${items.length} 项）`}>
                  <span />
                </Spin>
              ) : (
                <Typography.Text type="secondary">
                  上滑自动加载更多（已加载 {items.length} 项）
                </Typography.Text>
              )
            ) : (
              items.length > 0 && (
                <Typography.Text type="secondary">已全部加载（共 {items.length} 项）</Typography.Text>
              )
            )}
            {/* 手动兜底：自动加载失败时可点击；e2e 亦可沿用 data-testid="load-more" */}
            {nextMarker !== null && !loadingMore ? (
              <Button
                data-testid="load-more"
                size="small"
                type="link"
                onClick={() => void loadMore()}
              >
                手动加载更多
              </Button>
            ) : null}
          </div>
        </Space>
      </div>
      {explorer.opened_file !== undefined ? <VideoPane mode="open" /> : null}
      {explorer.preview_file !== undefined ? <VideoPane mode="preview" /> : null}
    </div>
  );
}
