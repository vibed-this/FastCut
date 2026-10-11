/** 文件夹浏览：面包屑 + 缩略图网格（缩略图用 list_by_share 自带 thumbnail，命中本地磁盘缓存秒显，禁止逐项调 preview）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp, Breadcrumb, Button, Space, Spin, Typography } from "antd";
import {
  CheckCircleFilled,
  DownloadOutlined,
  FileOutlined,
  FolderFilled,
  LoadingOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import {
  downloadVideo,
  getStatusBatch,
  listShare,
  onDownloadDone,
  onDownloadProgress,
  videoPreview,
  warmThumbnails,
} from "../api";
import type { FileStatus, ShareItem } from "../api";
import { useStore } from "../store";
import VideoPane, { autoDownloadSilentIds, pickUsableTemplate } from "./VideoPane";

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
  /** 当前 hover 的磁贴 file_id（未保存视频 hover 时在角标位露出下载按钮）。 */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /** 磁贴直下取链中（preview 未返回、progress 事件未到前的空窗期即转圈、防连点）。 */
  const [tilePendingMap, setTilePendingMap] = useState<Record<string, boolean>>({});

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

  /**
   * 磁贴直下：不开播放器直接下载（hover 下载按钮用）。
   * 与 VideoPane.handleSave 同策略（最高档 + stack 子目录），但走手动路径：
   * 有开始/完成 toast，不进自动静默集合。取链空窗期用 tilePending 转圈。
   */
  async function handleTileDownload(item: ShareItem): Promise<void> {
    if (item.type === "folder" || !isVideoFile(item)) {
      return;
    }
    if (state.materialDir === "" || state.materialDir === null) {
      void message.warning("请先在左侧边栏配置素材文件夹");
      return;
    }
    if (
      tilePendingMap[item.file_id] === true ||
      currentExplorer.progress?.[item.file_id] !== undefined
    ) {
      return;
    }
    setTilePendingMap((prev) => ({ ...prev, [item.file_id]: true }));
    try {
      const statuses = await getStatusBatch(currentExplorer.share_id, [item.file_id]);
      if (statuses.some((s) => s.file_id === item.file_id && s.state === "saved")) {
        setStatusMap((prev) => {
          const map = { ...prev };
          for (const s of statuses) {
            map[s.file_id] = s;
          }
          return map;
        });
        void message.info("该文件已保存");
        return;
      }
      const list = await videoPreview(currentExplorer.share_id, item.drive_id, item.file_id);
      const picked = pickUsableTemplate(list);
      if (picked === undefined || picked.preview_url === undefined || picked.preview_url === "") {
        throw new Error("没有可用的预览档");
      }
      // sub_dir 为 stack 路径名 join（根目录除外），与 VideoPane 保存路径一致。
      const dirs = currentExplorer.stack
        .slice(1)
        .map((s) => s.name)
        .filter((n) => n !== "");
      await downloadVideo(
        picked.preview_url,
        currentExplorer.share_id,
        item.file_id,
        item.name,
        picked.template_id,
        dirs.join("/"),
      );
      void message.success("已开始下载");
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTilePendingMap((prev) => {
        const map = { ...prev };
        delete map[item.file_id];
        return map;
      });
    }
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
    const isVideo = isVideoFile(item);
    const previewable = isFolder || isVideo;
    const selected = currentExplorer.selected_file?.file_id === item.file_id;
    const st = statusMap[item.file_id];
    const downloading =
      !isFolder &&
      (currentExplorer.progress?.[item.file_id] !== undefined ||
        st?.state === "downloading" ||
        tilePendingMap[item.file_id] === true);
    /** 已保存落盘路径（拖出的真实文件）；下载中/未保存时为 undefined。 */
    const savedPath =
      !isFolder && !downloading && st?.state === "saved" && st.path !== undefined && st.path !== ""
        ? st.path
        : undefined;
    const hovered = hoveredId === item.file_id;
    // 左上角标三态（同坑位互斥）：下载中 loading / 已保存绿勾（可拖）/ hover 未保存下载按钮。
    const cornerMark = downloading ? (
      <span
        data-testid="tile-downloading"
        title="下载中…"
        style={{
          position: "absolute",
          top: 6,
          left: 6,
          zIndex: 1,
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fff",
          borderRadius: "50%",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
        }}
      >
        <LoadingOutlined style={{ fontSize: 14, color: "#1677ff" }} spin />
      </span>
    ) : savedPath !== undefined ? (
      <span
        data-testid="saved-mark"
        title="已保存，可拖到剪辑软件时间线"
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
    ) : !isFolder && isVideo && hovered ? (
      <button
        data-testid="tile-download"
        title="下载到素材库"
        aria-label={`下载${item.name}`}
        onClick={(e) => {
          e.stopPropagation();
          void handleTileDownload(item);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
        }}
        style={{
          position: "absolute",
          top: 6,
          left: 6,
          zIndex: 1,
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fff",
          border: "1px solid #1677ff",
          borderRadius: "50%",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <DownloadOutlined style={{ fontSize: 14, color: "#1677ff" }} />
      </button>
    ) : null;
    const cover = isFolder ? (
      <FolderFilled style={{ fontSize: 56, color: "#f5c542" }} />
    ) : item.thumbnail !== undefined && item.thumbnail !== "" ? (
      // 本地缓存命中秒显（media://），未命中先绘远程 URL，后台下完自动切换
      <ThumbImage src={thumbLocalMap[item.file_id] ?? item.thumbnail} name={item.name} video={isVideo} />
    ) : isVideo ? (
      <VideoCameraOutlined style={{ fontSize: 52, color: "#666" }} />
    ) : (
      <FileOutlined style={{ fontSize: 52, color: "#999" }} />
    );
    const draggable = savedPath !== undefined;
    return (
      <div
        data-testid={isFolder ? "enter-folder" : "preview-file"}
        title={draggable ? "已保存，可拖到剪辑软件时间线" : previewable ? undefined : "暂不支持预览"}
        draggable={draggable}
        onDragStart={(e) => {
          // Electron 原生拖出：交 main startDrag，OS 侧等价于从 Finder 拖出真实文件。
          if (savedPath === undefined) {
            return;
          }
          e.preventDefault();
          window.fastcut?.startFileDrag(savedPath);
        }}
        onClick={() => {
          if (isFolder) {
            enterFolder(item);
          } else if (isVideo) {
            selectFile(item);
          }
        }}
        onDoubleClick={() => {
          if (isFolder) {
            enterFolder(item);
          } else if (isVideo) {
            openFile(item);
          }
        }}
        style={{
          width: 132,
          padding: "12px 8px 8px",
          borderRadius: 8,
          border: selected ? "1px solid #1677ff" : "1px solid transparent",
          background: selected ? "#e6f4ff" : undefined,
          cursor: draggable ? "grab" : previewable ? "pointer" : "default",
          opacity: previewable ? 1 : 0.55,
          textAlign: "center",
        }}
        onMouseEnter={(e) => {
          setHoveredId(item.file_id);
          if (previewable && !selected) {
            e.currentTarget.style.background = "#f5f5f5";
          }
        }}
        onMouseLeave={(e) => {
          setHoveredId((prev) => (prev === item.file_id ? null : prev));
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
          {cornerMark}
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
