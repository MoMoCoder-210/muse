import { useCallback, useEffect, useState } from "react";
import { getSettings, saveSettings, detectFFmpeg } from "../../services/tauri";
import { ModelConfigSection } from "./ModelConfigSection";
import { DEFAULT_SETTINGS, type AppSettings } from "../../types/settings";
import { useToast } from "../../hooks/useToast";

type SettingsSection = "basic" | "models";
type ModelSection = "text" | "image" | "voice" | "asset";

type SettingsPageProps = {
  onClose: () => void;
};

const SETTINGS_NAV_ITEMS: Array<{
  key: SettingsSection;
  label: string;
  hint: string;
}> = [
  { key: "basic", label: "基础设置", hint: "应用级默认项与通用偏好" },
  { key: "models", label: "模型设置", hint: "管理语言、生图与语音模型" },
];

const MODEL_NAV_ITEMS: Array<{
  key: ModelSection;
  label: string;
}> = [
  { key: "text", label: "语言模型" },
  { key: "image", label: "生图模型" },
  { key: "voice", label: "语音模型" },
  { key: "asset", label: "素材管理" },
];

const API_FIELDS = [
  {
    key: "apiKey",
    label: "API Key",
    type: "password" as const,
    placeholder: "输入 API Key",
  },
  {
    key: "baseUrl",
    label: "Base URL",
    type: "text" as const,
    placeholder: "输入 API URL",
  },
  {
    key: "model",
    label: "模型 ID",
    type: "text" as const,
    placeholder: "输入 模型 ID",
  },
];

const TIMEOUT_FIELD = {
  key: "timeoutMs",
  label: "超时（毫秒）",
  type: "number" as const,
  min: 5000,
  max: 600000,
  step: 1000,
};

const TEXT_GROUPS = [
  {
    title: "基础 API 设置",
    description: "管理语言模型接入所需的密钥、服务地址与模型",
    fields: API_FIELDS,
  },
  {
    title: "其他参数设置",
    description: "控制文本生成的长度、采样温度与请求超时",
    fields: [
      TIMEOUT_FIELD,
      {
        key: "maxTokens",
        label: "最大 Token 数",
        type: "number" as const,
        min: 256,
        max: 256000,
        step: 256,
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number" as const,
        min: 0,
        max: 2,
        step: 0.1,
      },
    ],
  },
];

const IMAGE_GROUPS = [
  {
    title: "基础 API 设置",
    description: "管理生图模型接入所需的密钥、服务地址与模型 ID。",
    fields: API_FIELDS,
  },
  {
    title: "其他参数设置",
    description: "这里先保留请求超时等运行参数，后续再扩展更多默认值。",
    fields: [TIMEOUT_FIELD],
  },
];

const VOICE_GROUPS = [
  {
    title: "基础 API 设置",
    description: "管理语音模型接入所需的密钥、服务地址与模型 ID。",
    fields: API_FIELDS,
  },
  {
    title: "其他参数设置",
    description: "控制语音合成的请求超时与语速。音色不在全局设置里固定。",
    fields: [
      TIMEOUT_FIELD,
      {
        key: "speed",
        label: "语速",
        type: "number" as const,
        min: 0.5,
        max: 2.0,
        step: 0.1,
      },
    ],
  },
];

const ASSET_FIELDS = [
  {
    key: "apiKey",
    label: "API Key",
    type: "password" as const,
    placeholder: "输入方舟平台 API Key",
  },
  {
    key: "baseUrl",
    label: "Base URL",
    type: "text" as const,
    placeholder: "例如 https://ark.cn-beijing.volces.com/api",
  },
];

const ASSET_GROUPS = [
  {
    title: "火山方舟素材管理",
    description:
      "用于将本地资产图片上传至方舟平台，获取素材 ID 供视频生成时引用。与语言/生图/语音模型共用同一方舟账号即可。",
    fields: ASSET_FIELDS,
  },
  {
    title: "其他参数设置",
    description: "控制文件上传的请求超时时间。",
    fields: [TIMEOUT_FIELD],
  },
];

// --- 模型配置子组件 ---

interface ModelSectionProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}

function TextModelSection({ settings, onChange }: ModelSectionProps) {
  return (
    <ModelConfigSection<AppSettings["text"]>
      title="语言模型"
      description="用于剧本理解、拆分"
      groups={TEXT_GROUPS}
      values={settings.text}
      onChange={(next) => onChange({ ...settings, text: next })}
    />
  );
}

function ImageModelSection({ settings, onChange }: ModelSectionProps) {
  return (
    <ModelConfigSection<AppSettings["image"]>
      title="生图模型"
      description="用于资产图片生成"
      groups={IMAGE_GROUPS}
      values={settings.image}
      onChange={(next) => onChange({ ...settings, image: next })}
    />
  );
}

function VoiceModelSection({ settings, onChange }: ModelSectionProps) {
  return (
    <ModelConfigSection<AppSettings["voice"]>
      title="语音模型"
      description="用于语音合成"
      groups={VOICE_GROUPS}
      values={settings.voice}
      onChange={(next) => onChange({ ...settings, voice: next })}
    />
  );
}

function AssetModelSection({ settings, onChange }: ModelSectionProps) {
  return (
    <ModelConfigSection<AppSettings["asset"]>
      title="素材管理"
      description="用于上传资产图片至方舟平台，获取素材 ID 供视频生成引用"
      groups={ASSET_GROUPS}
      values={settings.asset}
      onChange={(next) => onChange({ ...settings, asset: next })}
    />
  );
}

/**
 * 设置页面
 *
 * @author yt @date 20260702
 */
export function SettingsPage({ onClose }: SettingsPageProps) {
  const { toast } = useToast();
  const [activeSection, setActiveSection] = useState<SettingsSection>("basic");
  const [activeModelSection, setActiveModelSection] = useState<ModelSection>("text");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ffmpegStatus, setFFmpegStatus] = useState<{
    available: boolean;
    ffmpeg_path: string;
    ffprobe_path: string;
    ffmpeg_exists: boolean;
    ffprobe_exists: boolean;
  } | null>(null);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(() => {
        toast("读取设置失败，请检查后端的日志。", "error");
      })
      .finally(() => setLoading(false));

    detectFFmpeg()
      .then(setFFmpegStatus)
      .catch(() => setFFmpegStatus(null));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await saveSettings(settings);
      toast("设置已保存。", "success");
    } catch (err) {
      toast("保存失败，请检查后端日志。", "error");
    } finally {
      setSaving(false);
    }
  }, [settings, toast]);

  function renderModelTabs() {
    return (
      <div className="import-tabs settings-subnav" role="tablist" aria-label="模型分类">
        {MODEL_NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={activeModelSection === item.key}
            className={`tab-btn settings-subnav-item ${activeModelSection === item.key ? "active" : ""}`}
            onClick={() => setActiveModelSection(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
    );
  }

  function renderContent() {
    if (loading) {
      return <div className="settings-loading">加载中…</div>;
    }

    if (activeSection === "basic") {
      return (
        <div className="settings-basic-page">
          <div className="panel-header">
            <h3>基础设置</h3>
            <p>应用级默认项与通用偏好。</p>
          </div>

          {/* FFmpeg 状态 */}
          <div className="settings-ffmpeg-section">
            <h4 className="settings-section-title">视频处理引擎</h4>
            {ffmpegStatus === null ? (
              <div className="settings-ffmpeg-card settings-ffmpeg-card--loading">
                <span className="spinner" aria-hidden />
                <span>正在检测 FFmpeg…</span>
              </div>
            ) : ffmpegStatus.available ? (
              <div className="settings-ffmpeg-card settings-ffmpeg-card--ok">
                <div className="settings-ffmpeg-header">
                  <div className="settings-ffmpeg-status">
                    <span className="settings-ffmpeg-dot settings-ffmpeg-dot--ok" />
                    <span className="settings-ffmpeg-status-text">FFmpeg 已就绪</span>
                  </div>
                  <span className="settings-ffmpeg-badge settings-ffmpeg-badge--ok">可用</span>
                </div>
                <div className="settings-ffmpeg-paths">
                  <div className="settings-ffmpeg-detail">
                    <span className="settings-ffmpeg-label">ffmpeg</span>
                    <span className="settings-ffmpeg-path" title={ffmpegStatus.ffmpeg_path}>
                      {ffmpegStatus.ffmpeg_path}
                    </span>
                  </div>
                  <div className="settings-ffmpeg-detail">
                    <span className="settings-ffmpeg-label">ffprobe</span>
                    <span className="settings-ffmpeg-path" title={ffmpegStatus.ffprobe_path}>
                      {ffmpegStatus.ffprobe_path}
                    </span>
                  </div>
                </div>
                <span className="settings-ffmpeg-desc">
                  视频拼接、归一化、时长探测等功能均可使用。
                </span>
              </div>
            ) : (
              <div className="settings-ffmpeg-card settings-ffmpeg-card--error">
                <div className="settings-ffmpeg-header">
                  <div className="settings-ffmpeg-status">
                    <span className="settings-ffmpeg-dot settings-ffmpeg-dot--error" />
                    <span className="settings-ffmpeg-status-text">FFmpeg 未检测到</span>
                  </div>
                  <span className="settings-ffmpeg-badge settings-ffmpeg-badge--error">不可用</span>
                </div>
                <span className="settings-ffmpeg-desc">
                  视频拼接等功能不可用。请将 ffmpeg.exe 和 ffprobe.exe 放入应用目录下的 ffmpeg/ 文件夹。
                </span>
                <div className="settings-ffmpeg-paths">
                  <div className="settings-ffmpeg-detail">
                    <span className="settings-ffmpeg-label">ffmpeg</span>
                    <span className="settings-ffmpeg-path settings-ffmpeg-path--missing">
                      {ffmpegStatus.ffmpeg_path || "未找到"}
                    </span>
                  </div>
                  <div className="settings-ffmpeg-detail">
                    <span className="settings-ffmpeg-label">ffprobe</span>
                    <span className="settings-ffmpeg-path settings-ffmpeg-path--missing">
                      {ffmpegStatus.ffprobe_path || "未找到"}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="settings-basic-grid">
            <div className="summary-card">
              <span className="settings-summary-label">后续承载</span>
              <strong>项目默认值</strong>
              <small>例如默认尺寸、默认输出目录、默认项目行为。</small>
            </div>
            <div className="summary-card">
              <span className="settings-summary-label">后续承载</span>
              <strong>运行与缓存</strong>
              <small>例如超时策略、缓存清理、临时文件与导出偏好。</small>
            </div>
          </div>
        </div>
      );
    }

    const sectionComponents: Record<string, React.ReactNode> = {
      text: <TextModelSection settings={settings} onChange={setSettings} />,
      image: <ImageModelSection settings={settings} onChange={setSettings} />,
      voice: <VoiceModelSection settings={settings} onChange={setSettings} />,
      asset: <AssetModelSection settings={settings} onChange={setSettings} />,
    };

    return (
      <div className="settings-model-page">
        {renderModelTabs()}
        {sectionComponents[activeModelSection] ?? sectionComponents.asset}
      </div>
    );
  }

  return (
    <div className="modal-backdrop settings-overlay" role="dialog" aria-modal="true" aria-label="应用设置">
      <div className="modal-panel settings-panel settings-panel--shell">
        <div className="modal-header settings-header">
          <div>
            <h2 className="settings-title">设置</h2>
          </div>
          <button
            type="button"
            className="icon-button modal-close-button"
            aria-label="关闭设置"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="settings-main">
          <aside className="settings-nav" aria-label="设置分类">
            <div className="settings-nav-group">
              {SETTINGS_NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`settings-nav-item ${activeSection === item.key ? "active" : ""}`}
                  onClick={() => setActiveSection(item.key)}
                >
                  <span className="settings-nav-label">{item.label}</span>
                  <span className="settings-nav-hint">{item.hint}</span>
                </button>
              ))}
            </div>
          </aside>

          <div className="settings-body">{renderContent()}</div>
        </div>

        <div className="settings-footer">
          <span className="settings-docs-link" />
          <div className="settings-footer-actions">
            <button type="button" className="ghost-button" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={handleSave}
              disabled={saving || loading}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
