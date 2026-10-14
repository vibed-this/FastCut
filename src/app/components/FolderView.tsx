/** 文件夹浏览：alipan 只读网格 + xiaohongshu 本地 fs 网格（面包屑走 relPath）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntdApp,
  Breadcrumb,
  Button,
  Input,
  Modal,
  Space,
  Spin,
  Tooltip,
  Typography,
} from "antd";
import {
  CheckCircleFilled,
  DeleteOutlined,
  DownloadOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderFilled,
  ImportOutlined,
  LoadingOutlined,
  SwapOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import {
  downloadImage,
  downloadVideo,
  fsList,
  fsMkdir,
  fsMove,
  fsRemove,
  fsRename,
  getStatusBatch,
  listShare,
  onDownloadDone,
  onDownloadProgress,
  videoPreview,
  readClipboardText,
  warmLocalVideoThumbnails,
  warmThumbnails,
  xhsImport,
} from "../api";
import type { FileStatus, FsEntry, ShareItem } from "../api";
import { detectShareLink } from "../../../electron/shared/share-link";
import { useStore, type ExplorerFile, type ExplorerProgress } from "../store";
import VideoPane, { autoDownloadSilentIds, pickUsableTemplate } from "./VideoPane";
import ImagePane, { imageAutoSaveFiredKeys, resolveImageHdUrl } from "./ImagePane";
import { toLocalMediaUrl } from "../../../electron/shared/media-url";
import { formatBytes, progressPercent, selectXhsPending } from "./pendingTiles";

/** 文件夹视图属性。 */
export interface FolderViewProps {
  /** 预留扩展，无必填项。 */
  className?: string;
}

/** 单页条数：与后端上限 100 对齐。 */
const PAGE_SIZE = 100;

/**
 * 网盘根目录是否应自动进入：仅当根目录唯一一条且为文件夹（无翻页剩余）。
 *
 * @param items - 根目录首屏条目
 * @param hasMore - 是否还有下一页（true 即根目录不止这些，不自动进入）
 * @returns 唯一文件夹条目（可进入），否则 undefined
 */
export function singleRootFolder(
  items: ShareItem[],
  hasMore: boolean,
): ShareItem | undefined {
  if (hasMore || items.length !== 1) {
    return undefined;
  }
  const only = items[0];
  return only !== undefined && only.type === "folder" ? only : undefined;
}

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

/** 图片扩展名（预览与磁贴共用；含常见静态/动态格式）。 */
const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "heif"];

/** 是否为图片文件（App 层空格/点击预览共用）。 */
export function isImageFile(item: ShareItem): boolean {
  if (item.type === "folder") {
    return false;
  }
  if (item.category === "image") {
    return true;
  }
  const ext = (item.file_extension ?? "").toLowerCase();
  if (ext !== "") {
    return IMAGE_EXTS.includes(ext);
  }
  return IMAGE_EXTS.includes(extOf(item.name));
}

/** 是否可预览（视频或图片；文件夹另行进入）。 */
export function isPreviewableFile(item: ShareItem): boolean {
  return isVideoFile(item) || isImageFile(item);
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function isVideoName(name: string): boolean {
  return ["mp4", "mkv", "mov", "m3u8", "avi", "webm"].includes(extOf(name));
}

function isImageName(name: string): boolean {
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "heif"].includes(extOf(name));
}

/** 本地条目 → 浏览文件（file_id 即 relPath，video/image 判定走扩展名）。 */
function fsEntryToFile(e: FsEntry): ExplorerFile {
  const video = !e.isDir && isVideoName(e.name);
  const image = !e.isDir && !video && isImageName(e.name);
  return {
    file_id: e.relPath,
    drive_id: "local",
    name: e.name,
    type: e.isDir ? "folder" : "file",
    category: video ? "video" : image ? "image" : undefined,
    file_extension: e.isDir ? undefined : extOf(e.name),
    absPath: e.absPath,
  };
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
 * 缩略图底部进度叠加：百分比 + 进度条；总量未知时展示已下载字节。
 *
 * @param props - 已下载量与总量
 * @returns 进度叠加元素
 */
function ThumbProgressOverlay(props: { done: number; total: number }): React.JSX.Element {
  const { done, total } = props;
  const pct = progressPercent(done, total);
  return (
    <div
      data-testid="tile-progress"
      title={pct !== null ? `下载中 ${pct}%` : `下载中 ${formatBytes(done)}`}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2,
        padding: "10px 6px 6px",
        background: "linear-gradient(transparent, rgba(0,0,0,0.7))",
        color: "#fff",
        fontSize: 11,
        lineHeight: "14px",
        textAlign: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          height: 4,
          borderRadius: 2,
          background: "rgba(255,255,255,0.35)",
          overflow: "hidden",
          marginBottom: 4,
        }}
      >
        <div
          style={{
            height: "100%",
            width: pct !== null ? `${pct}%` : "25%",
            background: "#1677ff",
            transition: "width 0.2s ease",
          }}
        />
      </div>
      <span>{pct !== null ? `${pct}%` : formatBytes(done)}</span>
    </div>
  );
}

/**
 * 文件夹视图（双模式：alipan 只读远端网格，xiaohongshu 本地 fs 网格+写操作）。
 *
 * @param props - 组件属性
 * @returns 文件夹浏览元素
 */
export default function FolderView(props: FolderViewProps): React.JSX.Element {
  const { className } = props;
  const { state, dispatch } = useStore();
  const { message, modal } = AntdApp.useApp();
  const explorer = state.explorer;
  const kind = explorer?.kind ?? "alipan";
  const isXhs = kind === "xiaohongshu";

  // ---- alipan 远端状态 ----
  const [items, setItems] = useState<ShareItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextMarker, setNextMarker] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, FileStatus>>({});
  /** 缩略图本地缓存：fileId → media:// 本地 URL；命中即秒显，不阻塞远程首绘。 */
  const [thumbLocalMap, setThumbLocalMap] = useState<Record<string, string>>({});
  /** 本地视频缩略图：relPath → media:// 本地 URL（ffmpeg 抽帧，失败回退图标）。 */
  const [localThumbMap, setLocalThumbMap] = useState<Record<string, string>>({});
  /** hover 命中收敛到 store（App 层空格预览共用同一目标）。 */
  /** 磁贴直下取链中（preview 未返回、progress 事件未到前的空窗期即转圈、防连点）。 */
  const [tilePendingMap, setTilePendingMap] = useState<Record<string, boolean>>({});
  /**
   * 根单文件夹已自动进入的合集 id：仅一次（点击合集打开时）。
   * 用户面包屑退回根目录不再重复进入；合集关闭（collectionKey 清空）后重置，
   * 保证下次重新打开同一合集仍可自动进入。
   */
  const autoEnteredRootRef = useRef<string | null>(null);

  // ---- xiaohongshu 本地状态 ----
  const [xhsItems, setXhsItems] = useState<FsEntry[]>([]);
  const [xhsLoading, setXhsLoading] = useState(false);
  const [xhsSelected, setXhsSelected] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  /** 导入弹窗输入是否仍是初始空值（剪贴板自动填入不覆盖用户输入）。 */
  const importPristineRef = useRef(true);
  const [importError, setImportError] = useState("");
  const [importConfirming, setImportConfirming] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const [mkdirLoading, setMkdirLoading] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveDest, setMoveDest] = useState("");
  const [moveLoading, setMoveLoading] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);
  /** 解析中占位（点导入后、后端开始推进度前的空窗期）：id 序列 + 原链接。 */
  const [xhsParsing, setXhsParsing] = useState<{ id: number; url: string }[]>([]);
  const parsingSeqRef = useRef(0);

  /** 后台预取一批缩略图（fire-and-forget：失败回退远程 URL，不弹错）。 */
  function warmBatch(collectionId: string, batch: ShareItem[]): void {
    const entries = batch
      .filter((i) => i.thumbnail !== undefined && i.thumbnail !== "")
      .map((i) => ({ fileId: i.file_id, url: i.thumbnail as string }));
    if (entries.length === 0) {
      return;
    }
    warmThumbnails(collectionId, entries)
      .then((cached) => {
        setThumbLocalMap((prev) => ({ ...prev, ...cached }));
      })
      .catch(() => undefined);
  }

  /** 把一批条目的状态并入映射（只查新增 id）。 */
  async function mergeStatuses(collectionId: string, batch: ShareItem[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }
    const statuses = await getStatusBatch(
      collectionId,
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
  const collectionKey = explorer?.collection_id ?? "";

  // 当前本地相对目录（xhs 栈顶 file_id 即 relPath）。
  const currentRelDir = useMemo(() => {
    if (explorer === undefined || explorer === null || explorer.stack.length === 0) return "";
    return explorer.stack[explorer.stack.length - 1]?.file_id ?? "";
  }, [explorer]);

  // 合集关闭后重置自动进入标记，下次重开同一合集仍可自动进入。
  useEffect(() => {
    if (collectionKey === "") {
      autoEnteredRootRef.current = null;
    }
  }, [collectionKey]);

  /** xhs 本地目录加载（视频条目顺带后台抽帧缩略图，fire-and-forget）。 */
  const loadXhs = useCallback(async () => {
    if (explorer === undefined || explorer === null || explorer.kind !== "xiaohongshu") {
      return;
    }
    const top = explorer.stack[explorer.stack.length - 1];
    const relDir = top?.file_id ?? "";
    setXhsLoading(true);
    try {
      const entries = await fsList(relDir);
      setXhsItems(entries);
      setXhsSelected([]);
      const videos = entries
        .filter((e) => !e.isDir && isVideoName(e.name))
        .map((e) => e.relPath);
      if (videos.length > 0) {
        warmLocalVideoThumbnails(videos)
          .then((cached) => {
            setLocalThumbMap((prev) => ({ ...prev, ...cached }));
          })
          .catch(() => undefined);
      }
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setXhsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionKey, stackKey]);

  const load = useCallback(async () => {
    if (explorer === undefined || explorer === null) {
      return;
    }
    if (explorer.kind === "xiaohongshu") {
      await loadXhs();
      return;
    }
    const current = explorer.stack[explorer.stack.length - 1];
    if (current === undefined) {
      return;
    }
    const isRoot = explorer.stack.length === 1;
    const collectionId = explorer.collection_id;
    setLoading(true);
    try {
      // 首屏只取一页，大目录靠“加载更多”续取，避免一次拉全卡死。
      const res = await listShare(explorer.collection_id, current.file_id, undefined, PAGE_SIZE);
      // 网盘合集根目录仅有一个文件夹时自动进入（仅打开合集那一次，退回根不重复触发）。
      if (isRoot && autoEnteredRootRef.current !== collectionId) {
        const onlyFolder = singleRootFolder(res.items, res.next_marker !== "");
        if (onlyFolder !== undefined) {
          autoEnteredRootRef.current = collectionId;
          setItems([]);
          setNextMarker(null);
          setStatusMap({});
          dispatch({
            type: "explorer/push",
            entry: { file_id: onlyFolder.file_id, name: onlyFolder.name },
          });
          return;
        }
      }
      setItems(res.items);
      setNextMarker(res.next_marker === "" ? null : res.next_marker);
      setStatusMap({});
      await mergeStatuses(explorer.collection_id, res.items);
      warmBatch(explorer.collection_id, res.items);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionKey, stackKey, loadXhs]);

  /** 用 next_marker 续取下一页并追加（loadingMore/到底 guard 防重复请求）。 */
  const loadMore = useCallback(async (): Promise<void> => {
    if (explorer === undefined || explorer === null || nextMarker === null || loadingMore || loading) {
      return;
    }
    if (explorer.kind === "xiaohongshu") return;
    const current = explorer.stack[explorer.stack.length - 1];
    if (current === undefined) {
      return;
    }
    setLoadingMore(true);
    try {
      const res = await listShare(explorer.collection_id, current.file_id, nextMarker, PAGE_SIZE);
      setItems((prev) => [...prev, ...res.items]);
      setNextMarker(res.next_marker === "" ? null : res.next_marker);
      await mergeStatuses(explorer.collection_id, res.items);
      warmBatch(explorer.collection_id, res.items);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionKey, stackKey, nextMarker, loadingMore, loading]);

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
  }, [loadMore, nextMarker, collectionKey, stackKey]);

  useEffect(() => {
    void load();
    // 挂载与 stack 变化时刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionKey, stackKey]);

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
        // 小红书载荷多带展示字段（name/relDir/cover/title），虚拟占位用；alipan 无则为 undefined。
        progress: {
          done: p.done,
          total: p.total,
          name: p.name,
          relDir: p.relDir,
          cover: p.cover,
          title: p.title,
        },
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
      const silent =
        autoDownloadSilentIds.has(d.file_id) || imageAutoSaveFiredKeys.has(d.file_id);
      autoDownloadSilentIds.delete(d.file_id);
      imageAutoSaveFiredKeys.delete(d.file_id);
      if (!d.ok) {
        void message.error(d.error ?? "下载失败");
      } else if (!silent) {
        void message.success("下载完成");
      }
      // xhs 导入完成后刷新本地列表。
      if (d.ok && explorer?.kind === "xiaohongshu") {
        void loadXhs();
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
  }, [collectionKey]);

  // 下载进度变化后刷新当前合集状态（含完成清空后终查一次，落"已保存"角标）；
  // 用 ref 跳过挂载首跑（load 已查过），key 未变（纯 done/total 推进）不重查。
  // 仅 alipan 模式需要（xhs 文件本就在磁盘上）。
  const prevProgressKey = useRef("");
  useEffect(() => {
    if (explorer === undefined || explorer === null || items.length === 0) {
      return;
    }
    if (explorer.kind === "xiaohongshu") return;
    if (progressKey === prevProgressKey.current) {
      return;
    }
    prevProgressKey.current = progressKey;
    let cancelled = false;
    void getStatusBatch(
      explorer.collection_id,
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
    return <Typography.Text type="secondary">暂无打开的合集，请从左侧选择</Typography.Text>;
  }
  /** 收窄后的当前浏览（闭包内直接用，避免 TS18048）。 */
  const currentExplorer = explorer;

  /** 进入文件夹。 */
  function enterFolder(item: ExplorerFile): void {
    dispatch({ type: "explorer/push", entry: { file_id: item.file_id, name: item.name } });
  }

  /** 单击打开完整播放器（选中 + 半透明遮罩 + 标题栏 + 下载）。 */
  function openFile(item: ExplorerFile): void {
    dispatch({ type: "explorer/select", file: item });
    dispatch({ type: "explorer/openFile", file: item });
  }

  /**
   * 磁贴直下：不开播放器直接下载（hover 下载按钮用）。
   * 视频与 VideoPane.handleSave 同策略（最高档 + stack 子目录）；
   * 图片直接下载服务端高清原图（`url` 字段）。走手动路径：
   * 有开始/完成 toast，不进自动静默集合。取链空窗期用 tilePending 转圈。
   * 仅 alipan 模式可用。
   */
  async function handleTileDownload(item: ExplorerFile): Promise<void> {
    if (currentExplorer.kind !== "alipan") return;
    if (item.type === "folder" || (!isVideoFile(item) && !isImageFile(item))) {
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
      const statuses = await getStatusBatch(currentExplorer.collection_id, [item.file_id]);
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
      // sub_dir 为 stack 路径名 join（根目录除外），与 VideoPane 保存路径一致。
      const dirs = currentExplorer.stack
        .slice(1)
        .map((s) => s.name)
        .filter((n) => n !== "");
      const subDir = dirs.join("/");
      if (isImageFile(item)) {
        const { primary } = resolveImageHdUrl(item);
        if (primary === "") {
          throw new Error("没有可用的图片地址");
        }
        await downloadImage(
          primary,
          currentExplorer.collection_id,
          item.file_id,
          item.name,
          subDir,
        );
      } else {
        const list = await videoPreview(currentExplorer.collection_id, item.drive_id, item.file_id);
        const picked = pickUsableTemplate(list);
        if (picked === undefined || picked.preview_url === undefined || picked.preview_url === "") {
          throw new Error("没有可用的预览档");
        }
        await downloadVideo(
          picked.preview_url,
          currentExplorer.collection_id,
          item.file_id,
          item.name,
          picked.template_id,
          subDir,
        );
      }
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

  // ---- xhs 写操作 ----

  /** 直接导入：解析与下载一次完成（解析在后端 xhs_import 内做），失败行内报错。 */
  async function handleImportConfirm(): Promise<void> {
    const url = importUrl.trim();
    if (url === "") {
      setImportError("请粘贴小红书链接");
      return;
    }
    setImportConfirming(true);
    setImportError("");
    // 解析空窗期先占位（后端 parse 完成后才有进度事件，见 xhsParsing 渲染）。
    parsingSeqRef.current += 1;
    const parsingId = parsingSeqRef.current;
    setXhsParsing((prev) => [...prev, { id: parsingId, url }]);
    try {
      await xhsImport(url, {
        collectionId: currentExplorer.collection_id,
        relDir: currentRelDir,
      });
      void message.success("已开始导入");
      setImportOpen(false);
      setImportUrl("");
      setImportError("");
      await loadXhs();
    } catch (e) {
      // 行内报错，不关弹窗，方便换链接重试
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setXhsParsing((prev) => prev.filter((p) => p.id !== parsingId));
      setImportConfirming(false);
    }
  }

  async function handleMkdirConfirm(): Promise<void> {
    const name = mkdirName.trim();
    if (name === "") {
      void message.warning("请输入文件夹名");
      return;
    }
    setMkdirLoading(true);
    try {
      await fsMkdir(currentRelDir, name);
      setMkdirOpen(false);
      setMkdirName("");
      await loadXhs();
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setMkdirLoading(false);
    }
  }

  function confirmXhsDelete(): void {
    if (xhsSelected.length === 0) {
      void message.warning("请先选择要删除的文件");
      return;
    }
    modal.confirm({
      title: `确定删除选中的 ${xhsSelected.length} 项吗？`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: () => {
        void (async () => {
          try {
            for (const rel of xhsSelected) {
              await fsRemove(rel);
            }
            void message.success("已删除");
            await loadXhs();
          } catch (e) {
            void message.error(e instanceof Error ? e.message : String(e));
          }
        })();
      },
    });
  }

  async function handleMoveConfirm(): Promise<void> {
    if (xhsSelected.length === 0) {
      void message.warning("请先选择要移动的文件");
      return;
    }
    const rawDest = moveDest.trim();
    if (rawDest === "") {
      void message.warning("请输入目标目录");
      return;
    }
    // 目标约束在当前合集内：单段名视为当前目录下的子目录；完整路径必须位于合集根内。
    const rootRel = currentExplorer.stack[0]?.file_id ?? "";
    const dest =
      rawDest.includes("/") || rawDest.includes("\\")
        ? rawDest
        : currentRelDir === ""
          ? rawDest
          : `${currentRelDir.replace(/\/+$/, "")}/${rawDest}`;
    if (rootRel !== "" && dest !== rootRel && !dest.startsWith(`${rootRel}/`)) {
      void message.warning("只能移动到当前合集内部目录");
      return;
    }
    setMoveLoading(true);
    try {
      for (const rel of xhsSelected) {
        await fsMove(rel, dest);
      }
      setMoveOpen(false);
      setMoveDest("");
      void message.success("已移动");
      await loadXhs();
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setMoveLoading(false);
    }
  }

  async function handleXhsRenameConfirm(): Promise<void> {
    if (xhsSelected.length !== 1) return;
    const target = xhsSelected[0];
    if (target === undefined) return;
    const newName = renameValue.trim();
    if (newName === "") {
      void message.warning("请输入新名称");
      return;
    }
    // 兼容旧后端：优先 fs_rename，失败回退 collection_rename 语义由 api 层处理；
    // 此处直接调 fsRename。
    setRenameLoading(true);
    try {
      await fsRename(target, newName);
      setRenameOpen(false);
      setRenameValue("");
      await loadXhs();
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameLoading(false);
    }
  }

  function toggleXhsSelect(relPath: string): void {
    setXhsSelected((prev) =>
      prev.includes(relPath) ? prev.filter((r) => r !== relPath) : [...prev, relPath],
    );
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

  const sortedXhs = useMemo(
    () =>
      [...xhsItems].sort((a, b) => {
        const af = a.isDir ? 0 : 1;
        const bf = b.isDir ? 0 : 1;
        return af - bf;
      }),
    [xhsItems],
  );

  /** 当前目录已有的真实文件名（虚拟占位去重退场用）。 */
  const xhsExistingNames = useMemo(() => new Set(sortedXhs.map((e) => e.name)), [sortedXhs]);
  /** 下载中虚拟占位：进度有、真实条目尚无的项（落盘刷新后自动退场）。 */
  const xhsPending = useMemo(
    () =>
      isXhs
        ? selectXhsPending(currentExplorer.progress, collectionKey, currentRelDir, xhsExistingNames)
        : [],
    // progress 为引用型：每次进度事件都是新对象，天然触发重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isXhs, currentExplorer.progress, collectionKey, currentRelDir, xhsExistingNames],
  );

  /** 单个缩略图磁贴（图片/视频均用服务端 thumbnail 快照，无则回退图标）。 */
  function renderTile(item: ExplorerFile): React.JSX.Element {
    const isFolder = item.type === "folder";
    const isVideo = isVideoFile(item);
    const isImage = !isFolder && !isVideo && isImageFile(item);
    const previewable = isFolder || isVideo || isImage;
    const selected = currentExplorer.selected_file?.file_id === item.file_id;
    const st = statusMap[item.file_id];
    const downloading =
      !isFolder &&
      (currentExplorer.progress?.[item.file_id] !== undefined ||
        st?.state === "downloading" ||
        tilePendingMap[item.file_id] === true);
    /** 下载进度（有数值才在缩略图上叠加展示；取链空窗期仅转圈）。 */
    const progEntry: ExplorerProgress | undefined = isFolder
      ? undefined
      : currentExplorer.progress?.[item.file_id];
    /** 已保存落盘路径（拖出的真实文件）；下载中/未保存时为 undefined。 */
    const savedPath =
      !isFolder && !downloading && st?.state === "saved" && st.path !== undefined && st.path !== ""
        ? st.path
        : undefined;
    const hovered = currentExplorer.hovered_file?.file_id === item.file_id;
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
    ) : !isFolder && (isVideo || isImage) && hovered ? (
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
    ) : isImage ? (
      <FileOutlined style={{ fontSize: 52, color: "#999" }} />
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
        tabIndex={previewable ? 0 : undefined}
        onClick={() => {
          if (isFolder) {
            enterFolder(item);
          } else if (isVideo || isImage) {
            openFile(item);
          }
        }}
        style={{
          width: 132,
          padding: "12px 8px 8px",
          borderRadius: 8,
          border: selected
            ? "1px solid #1677ff"
            : hovered
              ? "1px solid #91caff"
              : "1px solid transparent",
          background: selected ? "#e6f4ff" : hovered ? "#f0f6ff" : undefined,
          cursor: draggable ? "grab" : previewable ? "pointer" : "default",
          opacity: previewable ? 1 : 0.55,
          textAlign: "center",
          outline: "none",
        }}
        onMouseEnter={() => {
          dispatch({ type: "explorer/hover", file: item });
        }}
        onMouseLeave={() => {
          if (currentExplorer.hovered_file?.file_id === item.file_id) {
            dispatch({ type: "explorer/hover", file: undefined });
          }
        }}
        onFocus={() => {
          dispatch({ type: "explorer/hover", file: item });
        }}
        onBlur={() => {
          if (currentExplorer.hovered_file?.file_id === item.file_id) {
            dispatch({ type: "explorer/hover", file: undefined });
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
          {progEntry !== undefined && (progEntry.total > 0 || progEntry.done > 0) ? (
            <ThumbProgressOverlay done={progEntry.done} total={progEntry.total} />
          ) : null}
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

  /** 小红书本地磁贴（本地文件直接可拖，无下载态）。 */
  function renderXhsTile(entry: FsEntry): React.JSX.Element {
    const file = fsEntryToFile(entry);
    const isFolder = entry.isDir;
    const isVideo = !isFolder && isVideoFile(file);
    const isImage = !isFolder && !isVideo && isImageFile(file);
    const previewable = isFolder || isVideo || isImage;
    const selected =
      currentExplorer.selected_file?.file_id === entry.relPath ||
      xhsSelected.includes(entry.relPath);
    const downloading = currentExplorer.progress?.[entry.relPath] !== undefined;
    const localPath = entry.absPath;
    const cornerMark = downloading ? (
      <span
        data-testid="tile-downloading"
        title="导入中…"
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
    ) : null;
    const localImageSrc =
      isImage && entry.absPath !== undefined && entry.absPath !== ""
        ? toLocalMediaUrl(entry.absPath)
        : undefined;
    const cover = isFolder ? (
      <FolderFilled style={{ fontSize: 56, color: "#f5c542" }} />
    ) : isVideo && localThumbMap[entry.relPath] !== undefined ? (
      // ffmpeg 抽帧命中秒显（media://），未命中/失败回退图标
      <ThumbImage
        src={localThumbMap[entry.relPath] as string}
        name={entry.name}
        video
      />
    ) : isVideo ? (
      <VideoCameraOutlined style={{ fontSize: 52, color: "#666" }} />
    ) : isImage && localImageSrc !== undefined ? (
      // 本地图片直显原图（media://），失败回退图标
      <ThumbImage src={localImageSrc} name={entry.name} video={false} />
    ) : isImage ? (
      <FileOutlined style={{ fontSize: 52, color: "#999" }} />
    ) : (
      <FileOutlined style={{ fontSize: 52, color: "#999" }} />
    );
    const draggable = !isFolder && localPath !== undefined;
    return (
      <div
        data-testid={isFolder ? "enter-folder" : "preview-file"}
        title={draggable ? "本地文件，可拖到剪辑软件时间线" : previewable ? undefined : "暂不支持预览"}
        draggable={draggable}
        onDragStart={(e) => {
          if (localPath === undefined) return;
          e.preventDefault();
          window.fastcut?.startFileDrag(localPath);
        }}
        tabIndex={previewable ? 0 : undefined}
        onClick={() => {
          if (isFolder) {
            enterFolder(file);
          } else if (isVideo || isImage) {
            openFile(file);
          } else {
            toggleXhsSelect(entry.relPath);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          toggleXhsSelect(entry.relPath);
        }}
        style={{
          width: 132,
          padding: "12px 8px 8px",
          borderRadius: 8,
          border: selected ? "1px solid #1677ff" : "1px solid transparent",
          background: selected ? "#e6f4ff" : undefined,
          cursor: draggable ? "grab" : previewable ? "pointer" : "default",
          opacity: previewable || xhsSelected.includes(entry.relPath) ? 1 : 0.75,
          textAlign: "center",
          outline: "none",
        }}
        onMouseEnter={() => {
          dispatch({ type: "explorer/hover", file });
        }}
        onMouseLeave={() => {
          if (currentExplorer.hovered_file?.file_id === file.file_id) {
            dispatch({ type: "explorer/hover", file: undefined });
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
          ellipsis={{ rows: 2, tooltip: entry.name }}
          style={{ fontSize: 12, margin: "8px 0 2px", minHeight: 32, lineHeight: "16px" }}
        >
          {entry.name}
        </Typography.Paragraph>
      </div>
    );
  }

  /** 小红书下载中虚拟占位磁贴（文件未落盘、无真实条目；进度清/落盘后退场，不可点/不可拖）。 */
  function renderXhsPendingTile(
    key: string,
    prog: ExplorerProgress,
    name: string,
  ): React.JSX.Element {
    const coverUrl = prog.cover?.trim() ?? "";
    const cover =
      coverUrl !== "" ? (
        <ThumbImage src={coverUrl} name={name} video />
      ) : (
        <VideoCameraOutlined style={{ fontSize: 52, color: "#666" }} />
      );
    return (
      <div
        data-testid="pending-tile"
        data-progress-key={key}
        title={`下载中：${name}`}
        style={{
          width: 132,
          padding: "12px 8px 8px",
          borderRadius: 8,
          border: "1px dashed #91caff",
          background: "#f0f6ff",
          cursor: "default",
          opacity: 0.92,
          textAlign: "center",
          outline: "none",
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
          <span
            data-testid="tile-downloading"
            title="下载中…"
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              zIndex: 3,
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
          {cover}
          <ThumbProgressOverlay done={prog.done} total={prog.total} />
        </div>
        <Typography.Paragraph
          ellipsis={{ rows: 2, tooltip: name }}
          style={{ fontSize: 12, margin: "8px 0 2px", minHeight: 32, lineHeight: "16px" }}
        >
          {name}
        </Typography.Paragraph>
      </div>
    );
  }

  /** 小红书解析中占位（点导入后、后端开始推进度前的空窗期）。 */
  function renderXhsParsingTile(entry: { id: number; url: string }): React.JSX.Element {
    return (
      <div
        data-testid="pending-tile-parsing"
        title={entry.url}
        style={{
          width: 132,
          padding: "12px 8px 8px",
          borderRadius: 8,
          border: "1px dashed #d9d9d9",
          background: "#fafafa",
          cursor: "default",
          opacity: 0.85,
          textAlign: "center",
          outline: "none",
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
            background: "#f0f0f0",
          }}
        >
          <LoadingOutlined style={{ fontSize: 28, color: "#1677ff" }} spin />
        </div>
        <Typography.Paragraph
          ellipsis={{ rows: 2, tooltip: "正在解析链接…" }}
          style={{ fontSize: 12, margin: "8px 0 2px", minHeight: 32, lineHeight: "16px" }}
        >
          正在解析链接…
        </Typography.Paragraph>
      </div>
    );
  }

  const writeDisabledTip = "网盘合集为只读，仅支持浏览与下载";

  return (
    <div className={className} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Tooltip title={isXhs ? undefined : writeDisabledTip}>
              <Button
                data-testid="xhs-import-btn"
                icon={<ImportOutlined />}
                disabled={!isXhs}
                title={isXhs ? "粘贴小红书链接导入" : writeDisabledTip}
                onClick={() => {
                  setImportUrl("");
                  setImportError("");
                  importPristineRef.current = true;
                  setImportOpen(true);
                  // 剪贴板有小红书链接自动填入（只动 pristine 输入框）
                  void readClipboardText().then((text) => {
                    const hit = detectShareLink(text);
                    if (hit === null || hit.kind !== "xiaohongshu") {
                      return;
                    }
                    if (!importPristineRef.current) {
                      return;
                    }
                    importPristineRef.current = false;
                    setImportUrl(hit.url);
                  });
                }}
              >
                导入链接
              </Button>
            </Tooltip>
            <Tooltip title={isXhs ? undefined : writeDisabledTip}>
              <Button
                data-testid="xhs-mkdir-btn"
                icon={<FolderAddOutlined />}
                disabled={!isXhs}
                title={isXhs ? "在当前目录新建文件夹" : writeDisabledTip}
                onClick={() => {
                  setMkdirName("");
                  setMkdirOpen(true);
                }}
              >
                新建文件夹
              </Button>
            </Tooltip>
            <Tooltip title={isXhs ? undefined : writeDisabledTip}>
              <Button
                data-testid="xhs-delete-btn"
                icon={<DeleteOutlined />}
                danger
                disabled={!isXhs || xhsSelected.length === 0}
                title={isXhs ? "删除选中" : writeDisabledTip}
                onClick={confirmXhsDelete}
              >
                删除{xhsSelected.length > 0 ? `(${xhsSelected.length})` : ""}
              </Button>
            </Tooltip>
            <Tooltip title={isXhs ? undefined : writeDisabledTip}>
              <Button
                data-testid="xhs-move-btn"
                icon={<SwapOutlined />}
                disabled={!isXhs || xhsSelected.length === 0}
                title={isXhs ? "移动选中到指定目录" : writeDisabledTip}
                onClick={() => {
                  setMoveDest("");
                  setMoveOpen(true);
                }}
              >
                移动
              </Button>
            </Tooltip>
            {isXhs && xhsSelected.length === 1 ? (
              <Button
                data-testid="xhs-rename-btn"
                onClick={() => {
                  setRenameValue(
                    xhsSelected[0]?.split("/").pop() ?? "",
                  );
                  setRenameOpen(true);
                }}
              >
                重命名
              </Button>
            ) : null}
          </div>
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
          {isXhs ? (
            <Spin spinning={xhsLoading} tip="加载中…">
              {sortedXhs.length === 0 && !xhsLoading ? (
                <Typography.Text type="secondary">空文件夹</Typography.Text>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignContent: "flex-start" }}>
                  {xhsParsing.map((p) => (
                    <div key={`parsing-${p.id}`}>{renderXhsParsingTile(p)}</div>
                  ))}
                  {xhsPending.map((t) => (
                    <div key={t.key}>{renderXhsPendingTile(t.key, t.progress, t.name)}</div>
                  ))}
                  {sortedXhs.map((entry) => (
                    <div key={entry.relPath}>{renderXhsTile(entry)}</div>
                  ))}
                </div>
              )}
            </Spin>
          ) : (
            <>
              <Spin spinning={loading} tip="加载中…">
                {sortedItems.length === 0 && !loading ? (
                  <Typography.Text type="secondary">空文件夹</Typography.Text>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignContent: "flex-start" }}>
                    {sortedItems.map((item) => (
                      <div key={item.file_id}>{renderTile(item as ExplorerFile)}</div>
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
            </>
          )}
        </Space>
      </div>
      {explorer.opened_file !== undefined ? (
        isImageFile(explorer.opened_file) ? (
          <ImagePane mode="open" />
        ) : (
          <VideoPane mode="open" />
        )
      ) : null}
      {explorer.preview_file !== undefined ? (
        isImageFile(explorer.preview_file) ? (
          <ImagePane mode="preview" />
        ) : (
          <VideoPane mode="preview" />
        )
      ) : null}
      <Modal
        title="导入小红书链接"
        open={importOpen}
        confirmLoading={importConfirming}
        okText="导入"
        cancelText="取消"
        onOk={() => {
          void handleImportConfirm();
        }}
        onCancel={() => {
          setImportOpen(false);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Input
            data-testid="xhs-url-input"
            placeholder="粘贴小红书分享链接"
            value={importUrl}
            onChange={(e) => {
              importPristineRef.current = false;
              setImportUrl(e.target.value);
            }}
            onPressEnter={() => {
              void handleImportConfirm();
            }}
          />
          {importError !== "" ? <Typography.Text type="danger">{importError}</Typography.Text> : null}
        </div>
      </Modal>
      <Modal
        title="新建文件夹"
        open={mkdirOpen}
        confirmLoading={mkdirLoading}
        okText="新建"
        cancelText="取消"
        onOk={() => {
          void handleMkdirConfirm();
        }}
        onCancel={() => {
          setMkdirOpen(false);
        }}
      >
        <Input
          data-testid="xhs-mkdir-input"
          placeholder="文件夹名"
          value={mkdirName}
          onChange={(e) => {
            setMkdirName(e.target.value);
          }}
        />
      </Modal>
      <Modal
        title="移动到"
        open={moveOpen}
        confirmLoading={moveLoading}
        okText="移动"
        cancelText="取消"
        onOk={() => {
          void handleMoveConfirm();
        }}
        onCancel={() => {
          setMoveOpen(false);
        }}
      >
        <Input
          data-testid="xhs-move-input"
          placeholder="目标目录相对路径（空为合集根）"
          value={moveDest}
          onChange={(e) => {
            setMoveDest(e.target.value);
          }}
        />
      </Modal>
      <Modal
        title="重命名"
        open={renameOpen}
        confirmLoading={renameLoading}
        okText="保存"
        cancelText="取消"
        onOk={() => {
          void handleXhsRenameConfirm();
        }}
        onCancel={() => {
          setRenameOpen(false);
        }}
      >
        <Input
          data-testid="xhs-rename-input"
          placeholder="新名称"
          value={renameValue}
          onChange={(e) => {
            setRenameValue(e.target.value);
          }}
        />
      </Modal>
    </div>
  );
}
