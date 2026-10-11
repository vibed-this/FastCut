/** 视频预览与保存面板。 */
import { useEffect, useRef, useState } from "react";
import { Alert, App as AntdApp, Button, Card, Space, Tag, Typography } from "antd";
import Hls from "hls.js";
import {
  downloadVideo,
  getStatusBatch,
  onDownloadDone,
  onDownloadProgress,
  pickPreviewUrl,
  videoPreview,
} from "../api";
import type { VideoPreview } from "../api";
import { useStore } from "../store";

/** 视频面板属性。 */
export interface VideoPaneProps {
  /** 所属页签 id。 */
  tabId: string;
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

  /** 拉取可用档与播放地址。 */
  async function fetchPreview(): Promise<void> {
    if (tab === undefined || file === undefined) {
      return;
    }
    setLoading(true);
    setExpired(false);
    setExpiredMsg("");
    try {
      const list = await videoPreview(tab.share_id, file.drive_id, file.file_id);
      setTemplates(list);
      const picked = await pickPreviewUrl(tab.share_id, file.drive_id, file.file_id, definition);
      setPlayUrl(picked.url);
      dispatch({ type: "tabs/video", tabId, video: { url: picked.url, template: picked.template } });
      const statuses = await getStatusBatch(tab.share_id, [file.file_id]);
      setSaved(statuses.some((s) => s.file_id === file.file_id && s.state === "saved"));
    } catch (e) {
      setExpired(true);
      setExpiredMsg(e instanceof Error ? e.message : String(e));
      void message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, definition]);

  // 播放器接入：loading 期间 video 会被 skeleton 卸载重挂，必须把 loading
  // 纳入依赖，否则 playUrl 不变时 effect 不再跑、src 永不设置（黑屏）。
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
    const nativeHls =
      playUrl.includes(".m3u8") &&
      video.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (nativeHls) {
      video.src = playUrl;
    } else if (playUrl.includes(".m3u8") && Hls.isSupported()) {
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

  return (
    <Card title={file.name} size="small" loading={loading}>
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <video
          ref={videoRef}
          data-testid="preview-video"
          controls
          style={{ width: "100%", background: "#000" }}
        />
        <div>
          <Typography.Text type="secondary">可用清晰度：</Typography.Text>
          <Space wrap style={{ marginTop: 6 }}>
            {templates.length === 0 ? (
              <Typography.Text type="secondary">暂无可用档</Typography.Text>
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
          <Button
            onClick={() => {
              dispatch({ type: "tabs/select", tabId, file: undefined });
              dispatch({ type: "tabs/video", tabId, video: undefined });
              setPlayUrl("");
              setTemplates([]);
            }}
          >
            关闭预览
          </Button>
        </Space>
        {noMaterial ? <Alert type="warning" message="请先在左侧边栏配置素材文件夹后再保存" /> : null}
      </Space>
    </Card>
  );
}
