/** 视频预览与保存面板：空格预览弹窗 / 双击完整播放器 + xgplayer。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App as AntdApp, Button, Spin, Typography } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import Player from "xgplayer";
import HlsPlugin from "xgplayer-hls";
import "xgplayer/dist/index.min.css";
import { downloadVideo, getStatusBatch, videoPreview } from "../api";
import type { VideoPreview } from "../api";
import { useStore } from "../store";
import VideoPlayerModal from "./VideoPlayerModal";
import { toLocalMediaUrl } from "../../../electron/shared/media-url";

/** 播放器模式：open=双击完整播放器，preview=空格 Quick Look 预览。 */
export type VideoPaneMode = "open" | "preview";

/** 视频面板属性。 */
export interface VideoPaneProps {
  /** 播放器模式。 */
  mode: VideoPaneMode;
}

/**
 * 完整播放器的空格开关句柄（preview 模式不注册，空格只负责关闭）。
 * App 层全局空格处理经由此处触发播放/暂停，避免与 xgplayer 按键插件双重响应
 *（xgplayer 以 ignores 关闭 keyboard 插件）。
 */
export const playerControl: { toggle: (() => void) | null } = { toggle: null };

/**
 * 已自动保存的 fileKey（跨 open/preview 实例共享：预览触发过则完整模式不再重复触发，
 * 反之亦然；手动点保存不受此限制）。
 */
const autoSaveFiredKeys = new Set<string>();

/**
 * 自动下载触发的 file_id 集合：下载完成/开始 toast 对自动路径静默（手动点保存仍提示）。
 * FolderView 的 download-done 订阅经此判定；done 后删除。
 */
export const autoDownloadSilentIds = new Set<string>();

/**
 * 播放器错误对象 → 可读文案（xgplayer 抛的常是普通对象，直接 String 会变成 `[object Object]`）。
 *
 * @param err - 播放器 error 事件载荷
 * @returns 可读描述（空串表示无可用信息）
 */
function describePlayerError(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    try {
      const s = JSON.stringify(err);
      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    } catch {
      return "";
    }
  }
  return String(err);
}

/**
 * 本地选档：总是取宽度最大的可用档（finished 且有 preview_url），无画质选择。
 * 磁贴直下复用同一策略，保证两处下到同一清晰度。
 *
 * @param templates - 预览档列表
 * @returns 选中的档，无可用时 undefined
 */
export function pickUsableTemplate(templates: VideoPreview[]): VideoPreview | undefined {
  const usable = templates.filter(
    (t) => t.status === "finished" && typeof t.preview_url === "string" && t.preview_url.length > 0,
  );
  if (usable.length === 0) {
    return undefined;
  }
  return usable.reduce<VideoPreview | undefined>(
    (best, cur) => (best === undefined || (cur.template_width ?? 0) >= (best.template_width ?? 0) ? cur : best),
    undefined,
  );
}

/**
 * 视频面板（双模式）。
 *
 * @param props - 组件属性
 * @returns 预览元素
 */
export default function VideoPane(props: VideoPaneProps): React.JSX.Element {
  const { mode } = props;
  const { state, dispatch } = useStore();
  const { message } = AntdApp.useApp();
  const explorer = state.explorer;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const [playUrl, setPlayUrl] = useState("");
  /** 当前播放档的 template_id（最高档，下载时透传记账）。 */
  const [playTemplate, setPlayTemplate] = useState("");
  /** 本地播放地址（已保存时播本地落盘文件，为空则播远端 playUrl）。 */
  const [localUrl, setLocalUrl] = useState("");
  const [loading, setLoading] = useState(false);
  /** 视频宽高比（w/h）：loadedmetadata 后回填，Modal 按比例定窗消黑边。 */
  const [videoRatio, setVideoRatio] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [expiredMsg, setExpiredMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const file = mode === "open" ? explorer?.opened_file : explorer?.preview_file;
  const fileKey = file === undefined ? "" : `${file.drive_id}/${file.file_id}`;
  const isXhs = explorer?.kind === "xiaohongshu";

  // 下载进度/完成订阅搬到 FolderView（单实例，避免 open/preview 双实例重复 toast；
  // 且预览触发的下载也能推进度、刷磁贴状态）。

  /** 取链序号：StrictMode double-invoke 时只让最后一轮落地，避免多实例抢容器。 */
  const fetchSeqRef = useRef(0);
  /** 本地播放失败后是否已回退过远端（防循环）。 */
  const localFallbackDoneRef = useRef(false);
  /** handleSave 最新闭包（player effect 定义在前，事件触发时经此调用，避免过期 state）。 */
  const handleSaveRef = useRef<(auto: boolean) => Promise<void>>(async () => undefined);

  /**
   * 拉取播放源：xhs 模式直接播本地文件（media://file 绝对路径）；
   * alipan 已保存播本地落盘文件（media://），否则单次 preview 取最高档远端。
   * 本地文件被挪走/删除时由播放器 error 回退远端（xhs 无远端则报错）。
   */
  async function fetchPreview(): Promise<void> {
    if (explorer === undefined || explorer === null || file === undefined) {
      return;
    }
    const seq = fetchSeqRef.current + 1;
    fetchSeqRef.current = seq;
    // 新文件重取链：丢弃上一轮窗口比例与本地地址。
    setVideoRatio(null);
    setLocalUrl("");
    localFallbackDoneRef.current = false;
    setLoading(true);
    setExpired(false);
    setExpiredMsg("");
    try {
      if (explorer.kind === "xiaohongshu") {
        const abs = file.absPath;
        if (abs === undefined || abs === "") {
          throw new Error("本地文件路径缺失");
        }
        if (fetchSeqRef.current !== seq) return;
        setSaved(true);
        setLocalUrl(toLocalMediaUrl(abs));
        setLoading(false);
        return;
      }
      const statuses = await getStatusBatch(explorer.collection_id, [file.file_id]);
      if (fetchSeqRef.current !== seq) {
        return;
      }
      const savedEntry = statuses.find((s) => s.file_id === file.file_id && s.state === "saved");
      if (savedEntry?.path !== undefined && savedEntry.path !== "") {
        setSaved(true);
        setLocalUrl(toLocalMediaUrl(savedEntry.path));
        setLoading(false);
        return;
      }
      setSaved(false);
      await fetchRemote(seq);
    } catch (e) {
      if (fetchSeqRef.current !== seq) {
        return;
      }
      setExpired(true);
      setExpiredMsg(e instanceof Error ? e.message : String(e));
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (fetchSeqRef.current === seq) {
        setLoading(false);
      }
    }
  }

  /** 单次 preview 取最高档远端（本地选档，避免重复打接口）。仅 alipan。 */
  async function fetchRemote(seq: number): Promise<void> {
    if (explorer === null || explorer === undefined || file === undefined) {
      return;
    }
    const list = await videoPreview(explorer.collection_id, file.drive_id, file.file_id);
    if (fetchSeqRef.current !== seq) {
      return;
    }
    const picked = pickUsableTemplate(list);
    if (picked === undefined || !picked.preview_url) {
      throw new Error("没有可用的预览档");
    }
    setPlayUrl(picked.preview_url);
    setPlayTemplate(picked.template_id);
    dispatch({
      type: "explorer/video",
      video: { url: picked.preview_url, template: picked.template_id },
    });
  }

  useEffect(() => {
    void fetchPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  // xgplayer 接入：播放源就绪且不在 loading 期时创建实例（loading 结束容器才稳定挂载）。
  // 已保存播本地 mp4（无 Hls 插件、无跨域属性）；否则播远端 m3u8。
  // 无清晰度插件：永远播最高档，不提供切换。
  // 空格由 App 层全局接管：此处以 ignores 关掉 xgplayer keyboard 插件，避免双重响应；
  // 完整模式注册 playerControl.toggle 供空格开关，预览模式不注册（空格只关闭）。
  useEffect(() => {
    const container = containerRef.current;
    const src = localUrl !== "" ? localUrl : playUrl;
    if (container === null || loading || src === "") {
      return;
    }
    const isLocal = localUrl !== "";
    const player = new Player({
      el: container,
      url: src,
      plugins: isLocal ? [] : [HlsPlugin],
      ignores: ["keyboard"],
      playbackRate: [0.5, 1, 1.5, 2],
      width: "100%",
      height: "100%",
      autoplay: mode === "preview",
      videoAttributes: isLocal ? { preload: "metadata" } : { preload: "metadata", crossorigin: "anonymous" },
    });
    playerRef.current = player;
    if (mode === "open") {
      playerControl.toggle = (): void => {
        if (player.paused) {
          void player.play();
        } else {
          player.mediaPause();
        }
      };
    }
    // 播即存（仅 alipan：open 与 preview 均触发：第一次 play 自动走一次保存，等价于自动点下载按钮）；
    // 自动路径无开始/完成 toast；handleSave 内部已有已存短路 + 主进程重入 guard，
    // 跨实例重复由 autoSaveFiredKeys 拦。xhs 本地文件跳过。
    player.on("play", () => {
      if (isXhs) return;
      if (autoSaveFiredKeys.has(fileKey)) {
        return;
      }
      autoSaveFiredKeys.add(fileKey);
      void handleSaveRef.current(true);
    });
    // 首帧元数据就绪即回填宽高比，Modal 按比例定窗（竖视频竖窗，无黑边）。
    const innerVideo = container.querySelector("video");
    const readRatio = (): void => {
      const v = container.querySelector("video");
      if (v !== null && v.videoWidth > 0 && v.videoHeight > 0) {
        setVideoRatio(v.videoWidth / v.videoHeight);
      }
    };
    if (innerVideo !== null && innerVideo.readyState >= 1) {
      readRatio();
    } else {
      innerVideo?.addEventListener("loadedmetadata", readRatio, { once: true });
    }
    player.on("error", (err: unknown) => {
      // 本地文件被挪走/删除：alipan 回退远端播一次（仅一次，防循环）；xhs 直接报错。
      if (isLocal && !localFallbackDoneRef.current && !isXhs) {
        localFallbackDoneRef.current = true;
        setLocalUrl("");
        const seq = fetchSeqRef.current + 1;
        fetchSeqRef.current = seq;
        setLoading(true);
        void fetchRemote(seq)
          .catch((e: unknown) => {
            setExpired(true);
            setExpiredMsg(e instanceof Error ? e.message : String(e));
          })
          .finally(() => {
            if (fetchSeqRef.current === seq) {
              setLoading(false);
            }
          });
        return;
      }
      setExpired(true);
      const detail = describePlayerError(err);
      setExpiredMsg(
        isXhs
          ? detail === ""
            ? "本地文件无法播放（可能已损坏、被移动或被删除）"
            : `本地文件无法播放（${detail}）`
          : detail === ""
            ? "播放失败，点“重取链接”重试"
            : `播放失败（${detail}），点“重取链接”重试`,
      );
    });
    // 预览自动播放被浏览器拦截时退化为静音播（带声优先，实在不行先动起来）。
    player.on("autoplay_was_prevented", () => {
      if (mode !== "preview") {
        return;
      }
      const v = container.querySelector("video");
      if (v !== null) {
        v.muted = true;
        void v.play().catch(() => undefined);
      }
    });
    return () => {
      container.querySelector("video")?.removeEventListener("loadedmetadata", readRatio);
      if (mode === "open" && playerControl.toggle !== null) {
        playerControl.toggle = null;
      }
      playerRef.current = null;
      player.destroy();
    };
  }, [playUrl, localUrl, loading, mode, fileKey]);

  if (explorer === null || explorer === undefined || file === undefined) {
    return <Typography.Text type="secondary">请选择视频文件预览</Typography.Text>;
  }

  /** 保存当前视频（auto=true 为播即存自动触发：不展示开始/完成/已存 toast，失败仍提示）。xhs 本地文件无需保存。 */
  const curExplorer = explorer;
  const curFile = file;
  async function handleSave(auto = false): Promise<void> {
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
      if (playUrl === "") {
        void message.warning("播放地址尚未就绪，请稍后重试");
        return;
      }
      // sub_dir 为 stack 路径名 join（根目录除外）
      const dirs = curExplorer.stack
        .slice(1)
        .map((s) => s.name)
        .filter((n) => n !== "");
      const subDir = dirs.join("/");
      autoDownloadSilentIds.add(curFile.file_id);
      await downloadVideo(playUrl, curExplorer.collection_id, curFile.file_id, curFile.name, playTemplate, subDir);
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

  const noMaterial = state.materialDir === "";

  /** 关闭 viewer：open 清 opened_file，preview 清 preview_file；选中保留。 */
  const closeViewer = useCallback((): void => {
    dispatch({ type: mode === "open" ? "explorer/openFile" : "explorer/preview", file: undefined });
    dispatch({ type: "explorer/video", video: undefined });
    setPlayUrl("");
    setPlayTemplate("");
    setLocalUrl("");
    setVideoRatio(null);
    setExpired(false);
    setExpiredMsg("");
  }, [dispatch, mode]);

  const isOpen = mode === "open";

  return (
    <VideoPlayerModal
      open
      title={file.name}
      onClose={closeViewer}
      videoRatio={videoRatio}
      chrome={isOpen}
      dimmed={isOpen}
      actions={
        isOpen && !isXhs ? (
          <Button
            data-testid="save-video"
            type="primary"
            size="small"
            icon={<DownloadOutlined />}
            loading={saving}
            disabled={saved || noMaterial}
            title={noMaterial ? "请先在左侧边栏配置素材文件夹" : saved ? "已保存" : "保存当前视频"}
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
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "#000" }}>
        <div
          ref={containerRef}
          data-testid="preview-video"
          style={{ position: "absolute", inset: 0 }}
        />
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
        {expired ? (
          <div style={{ position: "absolute", left: 12, right: 12, bottom: 76, zIndex: 6 }}>
            <Alert
              type="error"
              message={isXhs ? "本地文件播放失败" : "链接过期请重试"}
              description={expiredMsg === "" ? undefined : expiredMsg}
              action={
                // 小红书播的是本地文件，无远端可重取，不展示按钮。
                isXhs ? undefined : (
                  <Button
                    size="small"
                    onClick={() => {
                      void fetchPreview();
                    }}
                  >
                    重取链接
                  </Button>
                )
              }
            />
          </div>
        ) : null}
      </div>
    </VideoPlayerModal>
  );
}
