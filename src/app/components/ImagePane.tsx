/** 图片预览面板：点击完整查看 / 空格 Quick Look 预览（复用 VideoPlayerModal 悬浮窗）。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App as AntdApp, Spin, Typography } from "antd";
import { getLocalThumbnail } from "../api";
import { useStore } from "../store";
import VideoPlayerModal from "./VideoPlayerModal";
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

  const [src, setSrc] = useState("");
  const [fallbackSrc, setFallbackSrc] = useState("");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failedMsg, setFailedMsg] = useState("");
  /** 图片宽高比（w/h）：onLoad 回填，Modal 按比例定窗消黑边（与视频同理）。 */
  const [imageRatio, setImageRatio] = useState<number | null>(null);

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
   * 解析图片地址：本地直拼 media://；远端先查本地缩略图缓存，
   * 未命中用服务端高清字段/提清晰度后的缩略图。
   */
  useEffect(() => {
    if (explorer === undefined || explorer === null || file === undefined) {
      return;
    }
    let cancelled = false;
    const cur = file;
    setSrc("");
    setFallbackSrc("");
    setFailed(false);
    setFailedMsg("");
    setLoading(true);
    setImageRatio(null);
    resetView();
    void (async () => {
      try {
        if (explorer.kind === "xiaohongshu") {
          const abs = cur.absPath;
          if (abs === undefined || abs === "") {
            throw new Error("本地文件路径缺失");
          }
          if (!cancelled) {
            setSrc(toLocalMediaUrl(abs));
            // loading 由 img onLoad 关闭（解码完成才撤 spinner）。
          }
          return;
        }
        // alipan：本地缩略图缓存优先（秒显），未命中走远端。
        try {
          const cached = await getLocalThumbnail(explorer.collection_id, cur.file_id);
          if (cancelled) return;
          if (cached !== null && cached !== "") {
            setSrc(cached);
            return;
          }
        } catch {
          // 缓存查询失败不阻断，回退远端。
        }
        if (cancelled) return;
        const raw = (cur as unknown as { url?: unknown }).url;
        const remoteHigh = typeof raw === "string" && raw !== "" ? raw : undefined;
        const thumb = cur.thumbnail ?? "";
        const primary = remoteHigh ?? (thumb !== "" ? upgradeThumbnailUrl(thumb) : "");
        if (primary === "") {
          throw new Error("没有可用的图片地址");
        }
        setFallbackSrc(remoteHigh !== undefined ? (thumb !== "" ? thumb : "") : thumb);
        setSrc(primary);
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

  /** 关闭 viewer：open 清 opened_file，preview 清 preview_file；选中保留（与 VideoPane 一致）。 */
  const closeViewer = useCallback((): void => {
    dispatch({ type: mode === "open" ? "explorer/openFile" : "explorer/preview", file: undefined });
    dispatch({ type: "explorer/video", video: undefined });
    setSrc("");
    setFallbackSrc("");
    setFailed(false);
    setFailedMsg("");
    setImageRatio(null);
    resetView();
  }, [dispatch, mode, resetView]);

  const isOpen = mode === "open";
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
            }}
            onError={() => {
              // 高清档签名失效时回退原缩略图；两者都失败才报错。
              if (fallbackSrc !== "" && fallbackSrc !== src) {
                const fb = fallbackSrc;
                setFallbackSrc("");
                setSrc(fb);
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
