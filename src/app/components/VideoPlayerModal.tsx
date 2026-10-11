/** 全屏视频播放器 Modal：经典播放器布局（标题栏 + 视频区 + 控制条）。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Typography } from "antd";
import { CloseOutlined, FullscreenOutlined } from "@ant-design/icons";

/** 全屏播放器 Modal 属性。 */
export interface VideoPlayerModalProps {
  /** 是否打开。 */
  open: boolean;
  /** 顶部标题栏文案（一般为文件名）。 */
  title: string;
  /** 标题栏右侧操作区（全屏按钮之前，如保存按钮）。 */
  actions?: ReactNode;
  /** 视频宽高比（w/h）：窗口按比例自适应，消除黑边；null 时用默认尺寸。 */
  videoRatio?: number | null;
  /** 关闭回调：ESC、遮罩点击、关闭按钮统一走这里。 */
  onClose: () => void;
  /** 中部视频区：调用方传入已接好播放源的 <video> 元素。 */
  children: ReactNode;
  /** 底部控制条：调用方传入操作区（保存/重试/清晰度等）。 */
  footer?: ReactNode;
}

/**
 * 全屏 Modal 播放器。
 *
 * 经典播放器布局：顶部标题栏 + 关闭按钮，中部视频区，底部控制条。
 * 播放/暂停、进度条、音量由中部 <video> 的原生 controls 提供，
 * 全屏按钮调用 Fullscreen API 将播放器容器全屏。
 *
 * @param props - 组件属性
 * @returns 播放器元素，关闭时返回 null
 */
export default function VideoPlayerModal(props: VideoPlayerModalProps): React.JSX.Element | null {
  const { open, title, actions, videoRatio, onClose, children, footer } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);
  // 窗口尺寸：按视频比例自适应（消除黑边），约束在视口内；无比例时默认尺寸。
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const fit = (): void => {
      const titleH = 45;
      const maxW = Math.min(1000, window.innerWidth * 0.92);
      const maxH = window.innerHeight * 0.86 - titleH;
      if (videoRatio === null || videoRatio === undefined || videoRatio <= 0) {
        setBoxSize({ width: Math.round(maxW), height: Math.round(Math.min(660, maxH)) });
        return;
      }
      let bw = maxW;
      let bh = bw / videoRatio;
      if (bh > maxH) {
        bh = maxH;
        bw = bh * videoRatio;
      }
      setBoxSize({ width: Math.max(320, Math.round(bw)), height: Math.max(240, Math.round(bh)) });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
    };
  }, [open, videoRatio]);

  /** 全屏按钮：将播放器容器全屏，已全屏则退出。 */
  const toggleFullscreen = useCallback(() => {
    const box = boxRef.current;
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (box !== null && typeof box.requestFullscreen === "function") {
      void box.requestFullscreen().catch(() => undefined);
    }
  }, []);

  // ESC 关闭 + body 滚动锁定，仅在打开期间生效。
  useEffect(() => {
    if (!open) {
      return;
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      data-testid="video-player-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        // 遮罩透明不可见但仍拦截点击：点中空白处关闭，内容区点击不关闭。
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        background: "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        ref={boxRef}
        data-testid="video-player-box"
        style={{
          width: boxSize === null ? "min(1000px, 92vw)" : boxSize.width,
          height: boxSize === null ? "min(660px, 86vh)" : boxSize.height,
          background: "#000",
          borderRadius: 12,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 18px 70px rgba(0, 0, 0, 0.65)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            background: "#141414",
            borderBottom: "1px solid #2a2a2a",
          }}
        >
          <Typography.Text
            ellipsis={{ tooltip: title }}
            style={{ flex: 1, minWidth: 0, color: "#fff", fontSize: 14 }}
          >
            {title}
          </Typography.Text>
          {actions}
          <Button
            data-testid="video-player-fullscreen"
            type="text"
            size="small"
            title="全屏"
            aria-label="全屏"
            icon={<FullscreenOutlined style={{ color: "#fff" }} />}
            onClick={toggleFullscreen}
          />
          <Button
            data-testid="video-player-close"
            type="text"
            size="small"
            title="关闭（ESC）"
            aria-label="关闭预览"
            icon={<CloseOutlined style={{ color: "#fff" }} />}
            onClick={onClose}
          />
        </div>
        <div
          data-testid="video-player-body"
          style={{
            background: "#000",
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div>
        </div>
        {footer !== undefined ? (
          <div
            data-testid="video-player-footer"
            style={{
              padding: "10px 12px",
              background: "#141414",
              borderTop: "1px solid #2a2a2a",
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
