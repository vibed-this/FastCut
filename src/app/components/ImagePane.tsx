/** 图片预览面板：点击完整查看 / 空格 Quick Look 预览（复用 VideoPlayerModal 悬浮窗）。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App as AntdApp, Button, Spin, Typography } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { downloadImage, getLocalThumbnail, getStatusBatch } from "../api";
import { useStore } from "../store";
import VideoPlayerModal from "./VideoPlayerModal";
import { autoDownloadSilentIds } from "./VideoPane";
import { toLocalMediaUrl } from "../../../electron/shared/media-url";

/** 播放器模式：open=点击完整查看，preview=空格 Quick Look 预览（与 VideoPane 对齐）。 */
export type ImagePaneMode = "open" | "preview";

/** 图片面板属性。 */
export interface ImagePaneProps {
  /** 模式。 */
  mode: ImagePaneMode;
}

/** 缩放上下限（1=贴合窗口；允许缩小到 0.1，最大 8 倍）。 */
export const IMAGE_MIN_SCALE = 0.1;
export const IMAGE_MAX_SCALE = 8;
/** 贴合窗口的基准缩放。 */
export const IMAGE_FIT_SCALE = 1;

/**
 * 缩略图提清晰度：服务端快照为 w_256 小图（`image/resize,w_256/...`），
 * 预览时把宽度换成 w_1920 取高清（与 share-api 的 IMAGE_URL_PROCESS 对齐）。
 * 签名在 query，oss-process 换档通常仍有效；失败时调用方回退原图。
 *
 * @param url - 原始缩略图 URL
 * @returns 提清晰度后的 URL（无 w_256 标记时原样返回）
 */
export function upgradeThumbnailUrl(url: string): string {
  if (!url.includes("w_256")) {
    return url;
  }
  return url.replace("w_256", "w_1920");
}

/**
 * 图片已自动查看保存的 fileKey（跨 open/preview 实例共享：预览触发过则完整模式不再重复触发，
 * 反之亦然；手动点保存不受此限制。与 VideoPane 的视频集合互不干扰）。
 */
export const imageAutoSaveFiredKeys = new Set<string>();

/**
 * 解析图片远端地址（纯函数，供面板与磁贴直下共用）：
 * 服务端 `url` 字段（image_url_process 高清原图）优先，否则提清晰度后的缩略图；
 * fallback 恒为原缩略图（高清档签名失效时回退；与 primary 相同时调用方须防循环）。
 *
 * @param file - 含 url/thumbnail 的条目
 * @returns 高清首选 + 回退地址（无可用时 primary 为空串）
 */
export function resolveImageHdUrl(file: { url?: string | null; thumbnail?: string }): {
  primary: string;
  fallback: string;
} {
  const raw = file.url;
  const remoteHigh = typeof raw === "string" && raw !== "" ? raw : undefined;
  const thumb = file.thumbnail ?? "";
  return {
    primary: remoteHigh ?? (thumb !== "" ? upgradeThumbnailUrl(thumb) : ""),
    fallback: thumb,
  };
}

/**
 * 图片面板（双模式，与 VideoPane 共用 Modal 外壳与空格语义）。
 *
 * - xiaohongshu 本地：absPath 经 media:// 直显原图；
 * - alipan 远端：本地缩略图缓存命中即秒显（media://），否则远端 thumbnail
 *   先尝试 w_1920 高清档，失败回退原缩略图；服务端额外返回的 `url`
 *   字段（image_url_process 高清图）优先使用。
 * - 窗口按图片原始比例贴合（经 videoRatio 透传，与视频一致，无黑边）；
 * - 图片整体式交互（不受框体裁切）：滚轮以光标为锚点整体缩放（1–8 倍），
 *   拖拽整体移动图片（任意缩放下均可），双击/点百分比复位。
 *
 * @param props - 组件属性
 * @returns 预览元素
 */
export default function ImagePane(props: ImagePaneProps): React.JSX.Element {
  const { mode } = props;
  const { state, dispatch } = useStore();
  const { message } = AntdApp.useApp();
  const explorer = state.explorer;

  const file = mode === "open" ? explorer?.opened_file : explorer?.preview_file;
  const fileKey = file === undefined ? "" : `${file.drive_id}/${file.file_id}`;
  const isXhs = explorer?.kind === "xiaohongshu";

  /** 已保存原图地址（优先展示）；为空则展示远端 primary。 */
  const [localUrl, setLocalUrl] = useState("");
  const [remotePrimary, setRemotePrimary] = useState("");
  const [remoteFallback, setRemoteFallback] = useState("");
  const src = localUrl !== "" ? localUrl : remotePrimary;
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failedMsg, setFailedMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /** 图片宽高比（w/h）：onLoad 回填，Modal 按比例定窗消黑边（与视频同理）。 */
  const [imageRatio, setImageRatio] = useState<number | null>(null);
  /** 本地原图加载失败后是否已回退过远端（防循环）。 */
  const localFallbackDoneRef = useRef(false);
  /** handleSave 最新闭包（img onLoad 经此调用，避免过期 state）。 */
  const handleSaveRef = useRef<(auto: boolean) => Promise<void>>(async () => undefined);

  // ---- 缩放 / 平移（ref 为真值源，state 只驱动渲染；避免 updater 内副作用） ----
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(IMAGE_MIN_SCALE);
  const offsetRef = useRef({ x: 0, y: 0 });
  const [scale, setScale] = useState(IMAGE_MIN_SCALE);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  /** 应用缩放+偏移（同步 ref 与 state）。 */
  const applyView = useCallback((s: number, o: { x: number; y: number }): void => {
    scaleRef.current = s;
    offsetRef.current = o;
    setScale(s);
    setOffset(o);
  }, []);

  /** 复位到贴合窗口。 */
  const resetView = useCallback((): void => {
    applyView(IMAGE_FIT_SCALE, { x: 0, y: 0 });
  }, [applyView]);

  /**
   * 解析图片地址（与 VideoPane.fetchPreview 同策略）：
   * xhs 本地直拼 media://；alipan 已保存播本地落盘原图，否则远端
   * （本地缩略图缓存秒显先行，未命中走服务端高清字段/提清晰度缩略图）。
   * 本地原图被挪走/删除时由 img onError 回退远端（仅一次，防循环）。
   */
  useEffect(() => {
    if (explorer === undefined || explorer === null || file === undefined) {
      return;
    }
    let cancelled = false;
    const cur = file;
    setLocalUrl("");
    setRemotePrimary("");
    setRemoteFallback("");
    setFailed(false);
    setFailedMsg("");
    setLoading(true);
    setImageRatio(null);
    localFallbackDoneRef.current = false;
    resetView();
    void (async () => {
      try {
        if (explorer.kind === "xiaohongshu") {
          const abs = cur.absPath;
          if (abs === undefined || abs === "") {
            throw new Error("本地文件路径缺失");
          }
          if (!cancelled) {
            setSaved(true);
            setLocalUrl(toLocalMediaUrl(abs));
            // loading 由 img onLoad 关闭（解码完成才撤 spinner）。
          }
          return;
        }
        // alipan：已保存优先本地原图（与视频一致，可拖拽、无签名过期）。
        const statuses = await getStatusBatch(explorer.collection_id, [cur.file_id]);
        if (cancelled) return;
        const savedEntry = statuses.find((s) => s.file_id === cur.file_id && s.state === "saved");
        if (savedEntry?.path !== undefined && savedEntry.path !== "") {
          setSaved(true);
          setLocalUrl(toLocalMediaUrl(savedEntry.path));
          setLoading(false);
          return;
        }
        setSaved(false);
        const { primary, fallback } = resolveImageHdUrl(cur);
        // 本地缩略图缓存优先秒显（media://），远端高清作加载失败回退。
        let first = primary;
        try {
          const cached = await getLocalThumbnail(explorer.collection_id, cur.file_id);
          if (cancelled) return;
          if (cached !== null && cached !== "") {
            first = cached;
          }
        } catch {
          // 缓存查询失败不阻断，回退远端。
        }
        if (cancelled) return;
        if (first === "") {
          throw new Error("没有可用的图片地址");
        }
        setRemoteFallback(first !== primary ? primary : fallback);
        setRemotePrimary(first);
      } catch (e) {
        if (!cancelled) {
          setFailed(true);
          setFailedMsg(e instanceof Error ? e.message : String(e));
          setLoading(false);
          void message.error(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  // 滚轮整体缩放（原生非 passive 监听，以光标为锚点；图片不被框体裁切，
  // 事件经 DOM 冒泡到达容器，图片拖离原位后悬停其上仍可缩放）。
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) {
      return;
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const prev = scaleRef.current;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.min(IMAGE_MAX_SCALE, Math.max(IMAGE_MIN_SCALE, prev * factor));
      if (next === prev) {
        return;
      }
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const o = offsetRef.current;
      const k = next / prev;
      // 光标下的图片像素缩放前后保持在光标处（含缩小到贴合以下）。
      const target = { x: cx - (cx - o.x) * k, y: cy - (cy - o.y) * k };
      applyView(next, target);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [applyView, src]);

  // 拖拽整体移动：任意缩放下均可按住拖走图片（图片不受框体裁切）；
  // window 上跟踪，松开结束。移丢了用双击/复位按钮找回。
  useEffect(() => {
    if (!dragging) {
      return;
    }
    const onMove = (e: MouseEvent): void => {
      const st = dragRef.current;
      if (st === null) {
        return;
      }
      const target = { x: st.ox + (e.clientX - st.sx), y: st.oy + (e.clientY - st.sy) };
      offsetRef.current = target;
      setOffset(target);
    };
    const onUp = (): void => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  if (explorer === null || explorer === undefined || file === undefined) {
    return <Typography.Text type="secondary">请选择图片文件预览</Typography.Text>;
  }

  /** 保存当前图片原图（auto=true 为查看即存自动触发：不展示开始/完成/已存 toast，失败仍提示）。xhs 本地文件无需保存。 */
  const curExplorer = explorer;
  const curFile = file;
  async function handleSave(auto = false): Promise<void> {
    if (curExplorer === undefined || curExplorer === null || curFile === undefined) {
      return;
    }
    if (curExplorer.kind === "xiaohongshu") {
      if (!auto) void message.info("本地文件无需保存");
      return;
    }
    if (state.materialDir === "") {
      void message.warning("请先在左侧边栏配置素材文件夹");
      return;
    }
    setSaving(true);
    try {
      const statuses = await getStatusBatch(curExplorer.collection_id, [curFile.file_id]);
      if (statuses.some((s) => s.file_id === curFile.file_id && s.state === "saved")) {
        setSaved(true);
        if (!auto) {
          void message.info("该文件已保存");
        }
        return;
      }
      const { primary } = resolveImageHdUrl(curFile);
      if (primary === "") {
        void message.warning("图片地址尚未就绪，请稍后重试");
        return;
      }
      // sub_dir 为 stack 路径名 join（根目录除外），与 VideoPane 保存路径一致。
      const dirs = curExplorer.stack
        .slice(1)
        .map((s) => s.name)
        .filter((n) => n !== "");
      autoDownloadSilentIds.add(curFile.file_id);
      await downloadImage(primary, curExplorer.collection_id, curFile.file_id, curFile.name, dirs.join("/"));
      if (!auto) {
        void message.success("已开始下载");
      }
    } catch (e) {
      autoDownloadSilentIds.delete(curFile.file_id);
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  handleSaveRef.current = handleSave;

  /** 关闭 viewer：open 清 opened_file，preview 清 preview_file；选中保留（与 VideoPane 一致）。 */
  const closeViewer = useCallback((): void => {
    dispatch({ type: mode === "open" ? "explorer/openFile" : "explorer/preview", file: undefined });
    dispatch({ type: "explorer/video", video: undefined });
    setLocalUrl("");
    setRemotePrimary("");
    setRemoteFallback("");
    setFailed(false);
    setFailedMsg("");
    setImageRatio(null);
    resetView();
  }, [dispatch, mode, resetView]);

  const isOpen = mode === "open";
  const noMaterial = state.materialDir === "";
  const offFit = Math.abs(scale - IMAGE_FIT_SCALE) > 1e-6;
  const moved = Math.abs(offset.x) > 0.5 || Math.abs(offset.y) > 0.5;

  return (
    <VideoPlayerModal
      open
      title={file.name}
      onClose={closeViewer}
      videoRatio={imageRatio}
      chrome={isOpen}
      dimmed={isOpen}
      transparent
      actions={
        isOpen && !isXhs ? (
          <Button
            data-testid="save-image"
            type="primary"
            size="small"
            icon={<DownloadOutlined />}
            loading={saving}
            disabled={saved || noMaterial}
            title={noMaterial ? "请先在左侧边栏配置素材文件夹" : saved ? "已保存" : "保存当前图片"}
            onClick={() => {
              void handleSave();
            }}
            style={
              saved || noMaterial
                ? { background: "#2a2a2a", borderColor: "#434343", color: "rgba(255, 255, 255, 0.5)" }
                : undefined
            }
          >
            {saved ? "已保存" : "保存"}
          </Button>
        ) : undefined
      }
    >
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          background: "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "visible",
        }}
        onMouseDown={(e) => {
          // 图片整体拖拽：任意缩放下左键按下即记录起点。
          if (e.button !== 0) {
            return;
          }
          e.preventDefault();
          dragRef.current = {
            sx: e.clientX,
            sy: e.clientY,
            ox: offsetRef.current.x,
            oy: offsetRef.current.y,
          };
          setDragging(true);
        }}
        onDoubleClick={() => {
          resetView();
        }}
      >
        {src !== "" && !failed ? (
          <img
            data-testid="preview-image"
            src={src}
            alt=""
            draggable={false}
            referrerPolicy="no-referrer"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                setImageRatio(img.naturalWidth / img.naturalHeight);
              }
              setLoading(false);
              // 查看即存（仅 alipan：open 与 preview 均触发：成功显示一次即自动保存原图，
              // 等价于自动点下载按钮；与视频播即存对齐，跨实例重复由 fired 集合拦）。
              if (!isXhs && !imageAutoSaveFiredKeys.has(fileKey)) {
                imageAutoSaveFiredKeys.add(fileKey);
                void handleSaveRef.current(true);
              }
            }}
            onError={() => {
              // 本地原图被挪走/删除：回退远端一次（仅一次，防循环）；xhs 无远端直接报错。
              if (localUrl !== "" && !localFallbackDoneRef.current && !isXhs) {
                localFallbackDoneRef.current = true;
                setLocalUrl("");
                return;
              }
              // 高清档签名失效时回退原缩略图；两者都失败才报错。
              if (remoteFallback !== "" && remoteFallback !== src) {
                setRemotePrimary(remoteFallback);
                setRemoteFallback("");
                return;
              }
              setFailed(true);
              setLoading(false);
              setFailedMsg("图片加载失败，可能是链接过期或文件不存在");
            }}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: "block",
              userSelect: "none",
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: "center",
              transition: dragging ? undefined : "transform 0.12s ease-out",
              cursor: dragging ? "grabbing" : "grab",
              // 阴影跟图片本体走（drop-shadow 按实际像素投影，缩放/移动时同步；
              // 不用 box-shadow：contain 留白时它会描出整个元素框）。
              filter: "drop-shadow(0 18px 50px rgba(0, 0, 0, 0.55))",
            }}
          />
        ) : null}
        {(offFit || moved) && !failed ? (
          <button
            data-testid="image-zoom-reset"
            aria-label={offFit ? `当前缩放 ${Math.round(scale * 100)}%，点击复位` : "图片已移位，点击复位"}
            onClick={(e) => {
              e.stopPropagation();
              resetView();
            }}
            style={{
              position: "absolute",
              right: 10,
              bottom: 10,
              zIndex: 7,
              border: "1px solid rgba(255,255,255,0.25)",
              borderRadius: 6,
              background: "rgba(0,0,0,0.6)",
              color: "#fff",
              fontSize: 12,
              lineHeight: "20px",
              padding: "2px 8px",
              cursor: "pointer",
            }}
          >
            {offFit ? `${Math.round(scale * 100)}% 复位` : "复位"}
          </button>
        ) : null}
        {loading ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0, 0, 0, 0.45)",
              zIndex: 5,
            }}
          >
            <Spin tip="加载中…" />
          </div>
        ) : null}
        {failed ? (
          <div style={{ position: "absolute", left: 12, right: 12, bottom: 24, zIndex: 6 }}>
            <Alert
              type="error"
              message="图片预览失败"
              description={failedMsg === "" ? undefined : failedMsg}
            />
          </div>
        ) : null}
      </div>
    </VideoPlayerModal>
  );
}
