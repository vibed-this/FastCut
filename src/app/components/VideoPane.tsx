/** 视频预览与保存面板：空格预览弹窗 / 双击完整播放器 + xgplayer。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App as AntdApp, Button, Spin, Typography } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import Player from "xgplayer";
import HlsPlugin from "xgplayer-hls";
import "xgplayer/dist/index.min.css";
import { downloadVideo, getStatusBatch, onDownloadDone, onDownloadProgress, videoPreview } from "../api";
import type { VideoPreview } from "../api";
import { useStore } from "../store";
import VideoPlayerModal from "./VideoPlayerModal";

/** 播放器模式：open=双击完整播放器，preview=空格 Quick Look 预览。 */
export type VideoPaneMode = "open" | "preview";

/** 视频面板属性。 */
export interface VideoPaneProps {
  /** 所属页签 id。 */
  tabId: string;
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
 * 本地选档（与后端 pick_template 同语义）：显式档精确命中，miss 回退最大宽度档。
 *
 * @param templates - 预览档列表
 * @param preference - 偏好档
 * @returns 选中的档，无可用时 undefined
 */
function pickUsableTemplate(templates: VideoPreview[], preference: string): VideoPreview | undefined {
  const usable = templates.filter(
    (t) => t.status === "finished" && typeof t.preview_url === "string" && t.preview_url.length > 0,
  );
  if (usable.length === 0) {
    return undefined;
  }
  const want = preference.trim().toUpperCase();
  if (want !== "" && want !== "AUTO") {
    const hit = usable.find((t) => t.template_id.toUpperCase() === want);
    if (hit !== undefined) {
      return hit;
    }
  }
  return usable.reduce<VideoPreview | undefined>(
    (best, cur) => (best === undefined || (cur.template_width ?? 0) >= (best.template_width ?? 0) ? cur : best),
    undefined,
  );
}

/**
 * 可用档（status finished 且有 preview_url）：驱动 xgplayer 清晰度列表。
 *
 * @param templates - 预览档列表
 * @returns 可播放的档
 */
function usableTemplates(templates: VideoPreview[]): VideoPreview[] {
  return templates.filter(
    (t) => t.status === "finished" && typeof t.preview_url === "string" && t.preview_url.length > 0,
  );
}

/**
 * 视频面板（双模式）。
 *
 * @param props - 组件属性
 * @returns 预览元素
 */
export default function VideoPane(props: VideoPaneProps): React.JSX.Element {
  const { tabId, mode } = props;
  const { state, dispatch } = useStore();
  const { message } = AntdApp.useApp();
  const tab = state.tabs.find((t) => t.id === tabId);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const [templates, setTemplates] = useState<VideoPreview[]>([]);
  const [playUrl, setPlayUrl] = useState("");
  const [loading, setLoading] = useState(false);
  /** 视频宽高比（w/h）：loadedmetadata 后回填，Modal 按比例定窗消黑边。 */
  const [videoRatio, setVideoRatio] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [expiredMsg, setExpiredMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const file = mode === "open" ? tab?.opened_file : tab?.preview_file;
  const fileKey = file === undefined ? "" : `${file.drive_id}/${file.file_id}`;
  const definition = state.definition;

  // 下载进度事件订阅（仅完整模式：下载入口只在那里，避免双实例重复 toast）。
  useEffect(() => {
    if (mode !== "open") {
      return;
    }
    let offProgress: (() => void) | null = null;
    let offDone: (() => void) | null = null;
    let cancelled = false;
    void onDownloadProgress((p) => {
      dispatch({
        type: "tabs/progress",
        tabId,
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
      dispatch({ type: "tabs/progressClear", tabId, file_id: d.file_id });
      if (!d.ok) {
        void message.error(d.error ?? "下载失败");
      } else {
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
  }, [tabId, mode]);

  // done 后刷新该 tab 状态：progress 清空即重查选中文件状态
  useEffect(() => {
    if (tab === undefined || file === undefined || saving) {
      return;
    }
    const prog = tab.progress?.[file.file_id];
    if (prog !== undefined) {
      return;
    }
    // 仅在已触发过保存后由事件驱动刷新，此处不主动轮询
  });

  /** 取链序号：StrictMode double-invoke 时只让最后一轮落地，避免多实例抢容器。 */
  const fetchSeqRef = useRef(0);

  /** 拉取可用档与播放地址（单次 preview，本地选档，避免重复打接口）。 */
  async function fetchPreview(): Promise<void> {
    if (tab === undefined || file === undefined) {
      return;
    }
    const seq = fetchSeqRef.current + 1;
    fetchSeqRef.current = seq;
    // 新文件/偏好重取链：丢弃上一轮播放器内切换的档位记忆与窗口比例。
    switchUrlRef.current = null;
    switchTemplateRef.current = null;
    setVideoRatio(null);
    setLoading(true);
    setExpired(false);
    setExpiredMsg("");
    try {
      const list = await videoPreview(tab.share_id, file.drive_id, file.file_id);
      if (fetchSeqRef.current !== seq) {
        return;
      }
      setTemplates(list);
      const picked = pickUsableTemplate(list, definition);
      if (picked === undefined || !picked.preview_url) {
        throw new Error(`没有可用的预览档（偏好 ${definition}）`);
      }
      setPlayUrl(picked.preview_url);
      dispatch({
        type: "tabs/video",
        tabId,
        video: { url: picked.preview_url, template: picked.template_id },
      });
      const statuses = await getStatusBatch(tab.share_id, [file.file_id]);
      if (fetchSeqRef.current !== seq) {
        return;
      }
      setSaved(statuses.some((s) => s.file_id === file.file_id && s.state === "saved"));
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

  useEffect(() => {
    void fetchPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, definition]);

  // xgplayer 接入：playUrl 就绪且不在 loading 期时创建实例（loading 结束容器才稳定挂载），
  // playUrl / templates / definition 变化时销毁重建，组件卸载时销毁。
  // 清晰度列表由全部可用档驱动，默认档复用 pickUsableTemplate（AUTO 即最高档）；
  // 播放器内切换清晰度经 definition_change 回写 playUrl（跳过重建，保存用当前档）。
  // 空格由 App 层全局接管：此处以 ignores 关掉 xgplayer keyboard 插件，避免双重响应；
  // 完整模式注册 playerControl.toggle 供空格开关，预览模式不注册（空格只关闭）。
  const switchUrlRef = useRef<string | null>(null);
  const switchTemplateRef = useRef<string | null>(null);
  /** playUrl 最新值（definition_change 回调闭包内读取，避免过期 state）。 */
  const playUrlRef = useRef("");
  useEffect(() => {
    playUrlRef.current = playUrl;
  }, [playUrl]);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || loading || playUrl === "") {
      return;
    }
    if (switchUrlRef.current === playUrl) {
      // 播放器内切换档位引起的状态同步，实例已在播该地址，无需重建。
      switchUrlRef.current = null;
      return;
    }
    const usable = usableTemplates(templates);
    const picked = pickUsableTemplate(templates, definition) ?? usable[0];
    if (picked === undefined || picked.preview_url === undefined) {
      return;
    }
    const activeTemplate = switchTemplateRef.current ?? picked.template_id;
    switchTemplateRef.current = null;
    const player = new Player({
      el: container,
      url: playUrl,
      plugins: [HlsPlugin],
      ignores: ["keyboard"],
      definition: {
        list: usable.map((t) => ({ url: t.preview_url as string, definition: t.template_id })),
        defaultDefinition: activeTemplate,
      },
      playbackRate: [0.5, 1, 1.5, 2],
      width: "100%",
      height: "100%",
      autoplay: mode === "preview",
      videoAttributes: { preload: "metadata", crossorigin: "anonymous" },
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
      setExpired(true);
      const detail = err instanceof Error ? err.message : String(err ?? "");
      setExpiredMsg(detail === "" ? "播放失败，点“重取链接”重试" : `播放失败（${detail}），点“重取链接”重试`);
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
    player.on("definition_change", (to: unknown) => {
      const item = to as { url?: unknown; definition?: unknown } | null | undefined;
      if (typeof item?.url !== "string" || item.url === "" || item.url === playUrlRef.current) {
        return;
      }
      switchUrlRef.current = item.url;
      switchTemplateRef.current =
        typeof item.definition === "string" && item.definition !== "" ? item.definition : null;
      playUrlRef.current = item.url;
      setPlayUrl(item.url);
      dispatch({
        type: "tabs/video",
        tabId,
        video: { url: item.url, template: switchTemplateRef.current ?? "" },
      });
    });
    return () => {
      container.querySelector("video")?.removeEventListener("loadedmetadata", readRatio);
      if (mode === "open" && playerControl.toggle !== null) {
        playerControl.toggle = null;
      }
      playerRef.current = null;
      player.destroy();
    };
  }, [playUrl, templates, loading, definition, mode]);

  if (tab === undefined || file === undefined) {
    return <Typography.Text type="secondary">请选择视频文件预览</Typography.Text>;
  }

  /** 保存当前视频。 */
  const curTab = tab;
  const curFile = file;
  async function handleSave(): Promise<void> {
    if (playUrl === "") {
      void message.warning("播放地址尚未就绪，请稍后重试");
      return;
    }
    if (state.materialDir === "") {
      void message.warning("请先在左侧边栏配置素材文件夹");
      return;
    }
    setSaving(true);
    try {
      const statuses = await getStatusBatch(curTab.share_id, [curFile.file_id]);
      if (statuses.some((s) => s.file_id === curFile.file_id && s.state === "saved")) {
        setSaved(true);
        void message.info("该文件已保存");
        return;
      }
      // sub_dir 为 stack 路径名 join（根目录除外）
      const dirs = curTab.stack
        .slice(1)
        .map((s) => s.name)
        .filter((n) => n !== "");
      const subDir = dirs.join("/");
      await downloadVideo(playUrl, curTab.share_id, curFile.file_id, curFile.name, definition, subDir);
      void message.success("已开始下载");
    } catch (e) {
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const noMaterial = state.materialDir === "";

  /** 关闭 viewer：open 清 opened_file，preview 清 preview_file；选中保留。 */
  const closeViewer = useCallback((): void => {
    dispatch({ type: mode === "open" ? "tabs/openFile" : "tabs/preview", tabId, file: undefined });
    dispatch({ type: "tabs/video", tabId, video: undefined });
    setPlayUrl("");
    setTemplates([]);
    setVideoRatio(null);
    setExpired(false);
    setExpiredMsg("");
  }, [dispatch, tabId, mode]);

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
        isOpen ? (
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
              message="链接过期请重试"
              description={expiredMsg === "" ? undefined : expiredMsg}
              action={
                <Button
                  size="small"
                  onClick={() => {
                    void fetchPreview();
                  }}
                >
                  重取链接
                </Button>
              }
            />
          </div>
        ) : null}
      </div>
    </VideoPlayerModal>
  );
}
