/** 图片预览面板：点击完整查看 / 空格 Quick Look 预览（复用 VideoPlayerModal 悬浮窗）。 */
import { useCallback, useEffect, useState } from "react";
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
    void (async () => {
      try {
        if (explorer.kind === "xiaohongshu") {
          const abs = cur.absPath;
          if (abs === undefined || abs === "") {
            throw new Error("本地文件路径缺失");
          }
          if (!cancelled) {
            setSrc(toLocalMediaUrl(abs));
            setLoading(false);
          }
          return;
        }
        // alipan：本地缩略图缓存优先（秒显），未命中走远端。
        try {
          const cached = await getLocalThumbnail(explorer.collection_id, cur.file_id);
          if (cancelled) return;
          if (cached !== null && cached !== "") {
            setSrc(cached);
            setLoading(false);
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
        setLoading(false);
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
  }, [dispatch, mode]);

  const isOpen = mode === "open";

  return (
    <VideoPlayerModal open title={file.name} onClose={closeViewer} chrome={isOpen} dimmed={isOpen}>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          background: "#000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {src !== "" && !failed ? (
          <img
            data-testid="preview-image"
            src={src}
            alt={file.name}
            referrerPolicy="no-referrer"
            onError={() => {
              // 高清档签名失效时回退原缩略图；两者都失败才报错。
              if (fallbackSrc !== "" && fallbackSrc !== src) {
                const fb = fallbackSrc;
                setFallbackSrc("");
                setSrc(fb);
                return;
              }
              setFailed(true);
              setFailedMsg("图片加载失败，可能是链接过期或文件不存在");
            }}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
          />
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
