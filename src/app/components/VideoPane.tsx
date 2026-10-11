/** 视频预览与保存面板：全屏 Modal 播放器。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App as AntdApp, Button, Space, Spin, Tag, Typography } from "antd";
import Hls from "hls.js";
import { downloadVideo, getStatusBatch, onDownloadDone, onDownloadProgress, videoPreview } from "../api";
import type { VideoPreview } from "../api";
import { useStore } from "../store";
import VideoPlayerModal from "./VideoPlayerModal";

/** 视频面板属性。 */
export interface VideoPaneProps {
  /** 所属页签 id。 */
  tabId: string;
}

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
 * 视频预览面板。
 *
 * @param props - 组件属性
 * @returns 预览元素
 */
export default function VideoPane(props: VideoPaneProps): React.JSX.Element {
  const { tabId } = props;
  const { state, dispatch } = useStore();
  const { message } = AntdApp.useApp();
  const tab = state.tabs.find((t) => t.id === tabId);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [templates, setTemplates] = useState<VideoPreview[]>([]);
  const [playUrl, setPlayUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [expiredMsg, setExpiredMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const file = tab?.selected_file;
  const fileKey = file === undefined ? "" : `${file.drive_id}/${file.file_id}`;
  const definition = state.definition;

  // 下载进度事件订阅
  useEffect(() => {
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
  }, [tabId]);

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

  /** 取链序号：StrictMode double-invoke 时只让最后一轮落地，避免多实例抢 video。 */
  const fetchSeqRef = useRef(0);

  /** 拉取可用档与播放地址（单次 preview，本地选档，避免重复打接口）。 */
  async function fetchPreview(): Promise<void> {
    if (tab === undefined || file === undefined) {
      return;
    }
    const seq = fetchSeqRef.current + 1;
    fetchSeqRef.current = seq;
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

  // 播放器接入：loading 期间 video 会被 skeleton 卸载重挂，必须把 loading
  // 纳入依赖，否则 playUrl 不变时 effect 不再跑、src 永不设置（黑屏）。
  // 注意：桌面 Chromium 对 mpegurl 的 canPlayType 返回 "maybe"，但 <video> 直塞
  // m3u8 在 http(s) origin 下会被 ORB 拦截（dev 必现 media_err=4），因此 m3u8
  // 一律走 hls.js（cors 拉取），不信任 canPlayType。
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || playUrl === "") {
      return;
    }
    // 先销毁旧实例
    if (hlsRef.current !== null) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (playUrl.includes(".m3u8") && Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setExpired(true);
          const code =
            data.type === "networkError" && data.response !== undefined
              ? ` http=${String(data.response.code)}`
              : "";
          setExpiredMsg(`hls ${data.type}/${String(data.details)}${code}`);
        }
      });
      hls.loadSource(playUrl);
      hls.attachMedia(video);
    } else {
      video.src = playUrl;
    }
    return () => {
      if (hlsRef.current !== null) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [playUrl, loading]);

  // tab 关闭时清理由卸载触发，此处兜底卸载销毁
  useEffect(
    () => () => {
      if (hlsRef.current !== null) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    },
    [],
  );

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

  /** 关闭全屏预览：Modal 的 ESC / 遮罩 / 关闭按钮统一走这里。 */
  const closePreview = useCallback((): void => {
    dispatch({ type: "tabs/select", tabId, file: undefined });
    dispatch({ type: "tabs/video", tabId, video: undefined });
    setPlayUrl("");
    setTemplates([]);
  }, [dispatch, tabId]);

  return (
    <VideoPlayerModal
      open
      title={file.name}
      onClose={closePreview}
      footer={
        <Space>
          <Button
            data-testid="save-video"
            type="primary"
            loading={saving}
            disabled={saved || noMaterial}
            onClick={() => {
              void handleSave();
            }}
          >
            {saved ? "已保存" : "保存"}
          </Button>
          <Button onClick={closePreview}>关闭预览</Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <Spin spinning={loading} tip="加载中…">
          <video
            ref={videoRef}
            data-testid="preview-video"
            controls
            preload="metadata"
            onError={() => {
              const v = videoRef.current;
              const code = v?.error ? ` media_err=${v.error.code}` : "";
              setExpired(true);
              setExpiredMsg(`video 元素加载失败${code}，点“重取链接”重试`);
            }}
            style={{ width: "100%", maxHeight: "60vh", background: "#000" }}
          />
        </Spin>
        <div>
          <Typography.Text type="secondary" style={{ color: "#bbb" }}>
            可用清晰度：
          </Typography.Text>
          <Space wrap style={{ marginTop: 6 }}>
            {templates.length === 0 ? (
              <Typography.Text type="secondary" style={{ color: "#888" }}>
                暂无可用档
              </Typography.Text>
            ) : (
              templates.map((t) => (
                <Tag key={t.template_id} color={t.preview_url ? "green" : "default"}>
                  {t.template_id}
                  {t.template_width !== undefined ? ` · ${t.template_width}` : ""}
                </Tag>
              ))
            )}
          </Space>
        </div>
        {expired ? (
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
        ) : null}
        {noMaterial ? <Alert type="warning" message="请先在左侧边栏配置素材文件夹后再保存" /> : null}
      </Space>
    </VideoPlayerModal>
  );
}
