/**
 * 镜头视频超分抽屉（右侧悬浮，MAC 风格）。
 *
 * 结构：视频预览 + 显卡提醒 + 模型/倍率分段选择 +
 * 底部操作栏（开始超分 → 超分中进度条 → 完成后“完成”按钮）。
 * 确认后弹窗不关闭，进度由父组件 upscaleRun 驱动实时显示。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { DisplayStoryboardVideo } from "./storyboard-types";
import type { UpscaleJob } from "../../services/tauri";

/** 超分模型选项 */
const MODEL_OPTIONS: { value: string; label: string; tag: string; desc: string }[] = [
  {
    value: "anime",
    label: "动漫视频",
    tag: "2x/3x/4x · 不限分辨率",
    desc: "专为动漫视频优化，不限输入分辨率，速度最快，支持 2x/3x/4x",
  },
  {
    value: "x4plus-anime",
    label: "动漫高清",
    tag: "固定 4x · 限 1080p",
    desc: "动漫场景的高细节版，画质优于动漫视频但更慢；固定 4x，最高支持 1080p 输入",
  },
  {
    value: "x4plus",
    label: "真人写实",
    tag: "固定 4x · 限 1080p",
    desc: "适合真人写实与普通画面，细节最丰富；固定 4x ，最高支持 1080p 输入",
  },
];

/** 放大倍数（动漫模型可选手动，4x 固定模型仅 4x） */
const SCALE_OPTIONS: { value: number; label: string }[] = [
  { value: 2, label: "2x" },
  { value: 3, label: "3x" },
  { value: 4, label: "4x" },
];

/** 固定 4x 的模型（原生 4x 模型，ncnn 仅支持 -s 4） */
const FIXED_4X_MODELS = new Set(["x4plus", "x4plus-anime"]);

/** 1080p 高度上限（4x 固定模型输入限制） */
const MAX_INPUT_HEIGHT = 1080;

/** 显卡提醒 / 提示图标（复用同一 SVG） */
const INFO_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </svg>
);

type Props = {
  /** 待超分的视频；null 表示抽屉关闭 */
  video: DisplayStoryboardVideo | null;
  /** GPU 支持状态：true=可用 / false=不支持 / null=检测中 */
  gpuOk: boolean | null;
  /** 抽屉是否正在执行关闭动画 */
  closing?: boolean;
  onClose: () => void;
  /** 全局超分运行状态（父组件维护；匹配当前视频时禁用按钮） */
  runState: UpscaleJob | null;
  /** 发起超分（入队后弹窗立即关闭，进度在视频批次列表展示），返回任务或 null */
  onStartUpscale: (
    opts: { model: string; scale: number },
  ) => Promise<UpscaleJob | null>;
};

export function StoryboardUpscaleDrawer({
  video,
  gpuOk,
  closing,
  onClose,
  runState,
  onStartUpscale,
}: Props) {
  const [model, setModel] = useState("anime");
  const [scale, setScale] = useState(2);
  // 源视频分辨率（由预览 video 的 loadedmetadata 提供；未知时视为不超限）
  const [videoHeight, setVideoHeight] = useState<number | null>(null);

  // 当前视频是否正在超分（父组件运行状态匹配；超分中禁用选项与开始按钮）
  const isThisRunning = !!video
    && !!runState
    && runState.storyboard_id === video.storyboard_id
    && runState.video_id === video.id;

  // 打开时重置参数（默认动漫视频模型 + 2x 倍率）
  useEffect(() => {
    if (video) {
      setModel("anime");
      setScale(2);
      setVideoHeight(null);
    }
  }, [video?.id]);

  if (!video) return null;

  const selectedModel = MODEL_OPTIONS.find((m) => m.value === model) ?? MODEL_OPTIONS[0];
  const src = convertFileSrc(video.file_path);
  const busy = gpuOk === false || gpuOk === null;
  // 固定 4x 模型：倍率锁定为 4x；超出 1080p 输入时禁用并提示
  const isFixed4x = FIXED_4X_MODELS.has(model);
  const overHeightLimit = isFixed4x && videoHeight !== null && videoHeight > MAX_INPUT_HEIGHT;
  const effectiveScale = isFixed4x ? 4 : scale;

  const handleModelChange = (value: string) => {
    setModel(value);
    // 切换到固定 4x 模型时同步倍率
    if (FIXED_4X_MODELS.has(value)) setScale(4);
  };

  const handleStart = () => {
    if (isThisRunning || overHeightLimit) return;
    // 发起超分：父组件收到请求后自动关闭抽屉，进度在视频批次列表展示
    void onStartUpscale({ model, scale: effectiveScale });
  };

  return createPortal(
    <>
      <div
        className={`asset-drawer-backdrop${closing ? " asset-drawer-backdrop--closing" : ""}`}
        onClick={onClose}
      />
      <aside
        className={`asset-drawer sbu-drawer${closing ? " asset-drawer--closing" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="asset-drawer-header">
          <div className="asset-drawer-title-row">
            <h2 className="asset-drawer-title">画质增强</h2>
          </div>
          <button type="button" className="icon-button modal-close-button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        {/* 内容区 */}
        <div className="asset-drawer-body">
          {/* 视频预览 */}
          <div className="sbu-preview">
            <video
              src={src}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={(e) => setVideoHeight(e.currentTarget.videoHeight)}
            />
          </div>

          {/* 显卡提醒 */}
          <div className={`sbu-gpu-tip${gpuOk === false ? " sbu-gpu-tip--warn" : ""}`}>
            {gpuOk === false ? (
              INFO_ICON
            ) : (
              <span className="sbu-gpu-tip-more" tabIndex={0} role="tooltip" aria-label="查看详细硬件配置要求">
                {INFO_ICON}
                <div className="sbu-gpu-tip-popover">
                  <div className="sbu-gpu-tip-popover-title">需要什么显卡？</div>
                  <ul className="sbu-gpu-tip-popover-list">
                    <li>支持 NVIDIA / AMD / Intel 显卡</li>
                    <li>显卡内存（显存）建议 4GB 以上</li>
                    <li>没有可用显卡加速时超分会禁用</li>
                  </ul>
                </div>
              </span>
            )}
            <span>
              {gpuOk === false
                ? "你的电脑没有可用的显卡，无法使用画质增强"
                : "画质增强使用显卡加速"}
            </span>
          </div>

          {/* 模型选择 */}
          <div className="sbu-section">
            <div className="sbu-section-head">
              <span className="sbu-section-label">模型</span>
            </div>
            <div className="segmented segmented--cols3">
              {MODEL_OPTIONS.map((m) => {
                const disabled = busy || isThisRunning || overHeightLimit;
                return (
                  <button
                    key={m.value}
                    type="button"
                    className={model === m.value ? "active" : ""}
                    onClick={() => handleModelChange(m.value)}
                    disabled={disabled}
                    title={disabled && overHeightLimit
                      ? `视频超过 1080p，${m.label} 不支持`
                      : undefined}
                  >
                    <span className="sbu-model-name">{m.label}</span>
                    <span className="sbu-model-tag">{m.tag}</span>
                  </button>
                );
              })}
            </div>
            <p className="sbu-section-desc">{selectedModel.desc}</p>
            {overHeightLimit && (
              <p className="sbu-section-warn">视频超过 1080p，通用/轻量模型不支持，请改用动漫优化模型</p>
            )}
          </div>

          {/* 倍率选择（仅动漫优化模型可选；x4plus 系列固定 4x，不显示） */}
          {!isFixed4x && (
            <div className="sbu-section">
              <div className="sbu-section-head">
                <span className="sbu-section-label">倍率</span>
              </div>
              <div className="segmented segmented--cols3">
                {SCALE_OPTIONS.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    className={effectiveScale === s.value ? "active" : ""}
                    onClick={() => setScale(s.value)}
                    disabled={busy || isThisRunning}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="sbu-section-desc">输出按视频分辨率的 {effectiveScale} 倍放大</p>
            </div>
          )}
        </div>

        {/* 底部操作栏：开始超分（发起后抽屉自动关闭，进度在视频批次列表展示） */}
        <div className="asset-drawer-footer">
          <button
            type="button"
            className="asset-drawer-btn asset-drawer-btn--primary"
            disabled={busy || overHeightLimit}
            onClick={handleStart}
          >
            {busy ? "检查显卡中…" : "开始超分"}
          </button>
        </div>
      </aside>
    </>,
    document.body,
  );
}
