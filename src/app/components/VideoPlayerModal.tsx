/** 视频播放器悬浮窗（类 macOS 空格预览）：标题栏 + 视频区，可选无框预览。 */
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
  /** 是否显示标题栏（标题 + 操作区 + 全屏/关闭按钮）；空格预览模式为 false。 */
  chrome?: boolean;
  /** 是否显示半透明遮罩（双击打开的完整播放器为 true，空格预览为 false）。 */
  dimmed?: boolean;
  /**
   * 媒体框透明无底、允许溢出（图片整体缩放用：图片放大移出框体时不被裁切，
   * 框体只保留定位作用；视频保持默认黑底裁切）。
   */
  transparent?: boolean;
  /** 关闭回调：ESC、遮罩点击、关闭按钮统一走这里。 */
  onClose: () => void;
  /** 中部视频区：调用方传入已接好播放源的 <video> 元素。 */
  children: ReactNode;
}

/**
 * 视频播放器悬浮窗。
 *
 * 完整模式：标题栏（标题 + 操作区 + 全屏/关闭）+ 视频区；
 * 空格预览模式（chrome=false）：纯视频区，无标题栏无下载。
 * dimmed 控制是否显示半透明遮罩（完整模式 true，预览 false）。
 *
 * @param props - 组件属性
 * @returns 播放器元素，关闭时返回 null
 */
export default function VideoPlayerModal(props: VideoPlayerModalProps): React.JSX.Element | null {
  const { open, title, actions, videoRatio, chrome = true, dimmed = false, transparent = false, onClose, children } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);
  // 窗口尺寸：视频区按原始比例贴合（无黑边），总高度 = 视频区 + 标题栏；约束在视口内。
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const fit = (): void => {
      const titleH = chrome ? 45 : 0;
      const maxW = Math.min(1000, window.innerWidth * 0.92);
      const maxVideoH = Math.max(120, window.innerHeight * 0.86 - titleH);
      if (videoRatio === null || videoRatio === undefined || videoRatio <= 0) {
        setBoxSize({ width: Math.round(maxW), height: Math.round(Math.min(660, maxVideoH) + titleH) });
        return;
      }
      // 先按宽贴合，超高则按高回算，保证视频区宽高比 == 原始比例。
      let vw = maxW;
      let vh = vw / videoRatio;
      if (vh > maxVideoH) {
        vh = maxVideoH;
        vw = vh * videoRatio;
      }
      // 保比例下限：过小窗口按比例放大，但不超出视口约束（冲突时优先视口）。
      const minVw = 320;
      const minVh = 200;
      if (vw < minVw || vh < minVh) {
        const scale = Math.max(minVw / vw, minVh / vh);
        const upW = vw * scale;
        const upH = vh * scale;
        if (upW <= maxW && upH <= maxVideoH) {
          vw = upW;
          vh = upH;
        }
      }
      setBoxSize({ width: Math.round(vw), height: Math.round(vh + titleH) });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
    };
  }, [open, videoRatio, chrome]);

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

  // 进出场动画：open 关闭后延迟卸载，播完退出动画再返回 null。
  const [render, setRender] = useState(open);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (open) {
      setRender(true);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setRender(false);
    }, 160);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open]);

  if (!render) {
    return null;
  }

  // 无 footer：下载收进标题栏 actions，底部不再留条。
  return (
    <>
      <style>
        {`@keyframes fc-modal-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes fc-modal-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes fc-modal-zoom-in { from { opacity: 0; transform: scale(0.92) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes fc-modal-zoom-out { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.95); } }
[data-testid="video-player-body"] video { object-fit: contain !important; background: #000; }`}
      </style>
    <div
      data-testid="video-player-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        // 点中空白处关闭，内容区点击不关闭。
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        background: dimmed ? "rgba(0, 0, 0, 0.55)" : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        pointerEvents: leaving ? "none" : "auto",
        animation: leaving ? "fc-modal-fade-out 0.16s ease-in forwards" : "fc-modal-fade-in 0.16s ease-out",
      }}
    >
      <div
        ref={boxRef}
        data-testid="video-player-box"
        style={{
          width: boxSize === null ? "min(1000px, 92vw)" : boxSize.width,
          height: boxSize === null ? "min(660px, 86vh)" : boxSize.height,
          background: transparent ? "transparent" : "#000",
          borderRadius: 12,
          overflow: transparent ? "visible" : "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: transparent ? "none" : "0 18px 70px rgba(0, 0, 0, 0.65)",
          animation: leaving
            ? "fc-modal-zoom-out 0.16s ease-in forwards"
            : "fc-modal-zoom-in 0.2s cubic-bezier(0.2, 0.9, 0.25, 1.2)",
        }}
      >
        {chrome ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              height: 45,
              boxSizing: "border-box",
              padding: "0 12px",
              background: "#141414",
              borderBottom: "1px solid #2a2a2a",
              // transparent 下框体不再裁切，标题栏自带上圆角。
              borderTopLeftRadius: transparent ? 12 : 0,
              borderTopRightRadius: transparent ? 12 : 0,
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
        ) : null}
        <div
          data-testid="video-player-body"
          style={{
            background: transparent ? "transparent" : "#000",
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: transparent ? "visible" : "hidden",
          }}
        >
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div>
        </div>
      </div>
    </div>
    </>
  );
}
