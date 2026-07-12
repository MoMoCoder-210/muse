import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings, saveSettings, detectFFmpeg } from "../../services/tauri";
import { ChannelManager } from "./ChannelManager";
import {
  DEFAULT_SETTINGS,
  DEFAULT_TEXT_CHANNEL,
  DEFAULT_IMAGE_CHANNEL,
  DEFAULT_VOICE_CHANNEL,
  DEFAULT_VIDEO_CHANNEL,
  type AppSettings,
} from "../../types/settings";
import { VIDEO_RESOLUTION_OPTIONS } from "../../config/muse";
import { useToast } from "../../hooks/useToast";

// ── 导航 ────────────────────────────────────────────────

type Section = "basic" | "models";
type ModelTab = "text" | "image" | "voice" | "video";

const SECTIONS = [
  { key: "basic" as const,  label: "基础设置", hint: "FFmpeg 引擎与通用偏好" },
  { key: "models" as const, label: "模型设置", hint: "API 渠道与模型管理" },
];

const MODEL_TABS: Array<{ key: ModelTab; label: string }> = [
  { key: "text",  label: "语言模型" },
  { key: "image", label: "生图模型" },
  { key: "voice", label: "语音模型" },
  { key: "video", label: "视频模型" },
];

// ── 渠道级字段（仅 key+url+名称，调优参数走全局） ──────

const CHANNEL_FIELDS = [
  { key: "name",   label: "名称",  type: "text" as const,     placeholder: "请输入名称" },
  { key: "apiKey", label: "API Key",  type: "password" as const, placeholder: "请输入Api Key" },
  { key: "baseUrl",label: "Base URL", type: "text" as const,     placeholder: "请输入URL" },
];

// ── 全局参数字段（按类型） ──────────────────────────────

const TEXT_PARAMS_FIELDS = [
  { key: "timeoutMs",   label: "超时 (ms)", type: "number" as const, min: 5000, max: 600000, step: 1000 },
  { key: "maxTokens",   label: "最大 Token", type: "number" as const, min: 256, max: 256000, step: 256 },
  { key: "temperature", label: "温度",       type: "number" as const, min: 0, max: 2, step: 0.1 },
];

const IMAGE_PARAMS_FIELDS = [
  { key: "timeoutMs", label: "超时 (ms)", type: "number" as const, min: 5000, max: 600000, step: 1000 },
];

const VOICE_PARAMS_FIELDS = [
  { key: "timeoutMs", label: "超时 (ms)", type: "number" as const, min: 5000, max: 600000, step: 1000 },
  { key: "speed",     label: "语速",     type: "number" as const, min: 0.5, max: 2.0, step: 0.1 },
];

const VIDEO_PARAMS_FIELDS = [
  { key: "timeoutMs", label: "超时 (ms)", type: "number" as const, min: 5000, max: 1200000, step: 1000 },
];

// ── 组件 ────────────────────────────────────────────────

type Props = { onClose: () => void };

export function SettingsPage({ onClose }: Props) {
  const { toast } = useToast();
  const [section, setSection] = useState<Section>("basic");
  const [tab, setTab] = useState<ModelTab>("text");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const [loading, setLoading] = useState(true);
  const [ffmpeg, setFFmpeg] = useState<{
    available: boolean;
    ffmpeg_path: string; ffprobe_path: string;
    ffmpeg_exists: boolean; ffprobe_exists: boolean;
  } | null>(null);

  useEffect(() => {
    getSettings().then(setSettings).catch(() => toast("读取设置失败", "error")).finally(() => setLoading(false));
    detectFFmpeg().then(setFFmpeg).catch(() => setFFmpeg(null));
  }, []);

  /** 以完整设置对象即时持久化；统一以 settingsRef.current 为基准，避免闭包陈旧导致覆盖 */
  const persist = useCallback(async (next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
    try {
      await saveSettings(next);
      toast("设置已保存并生效，无需重启", "success");
    } catch (e) {
      toast("设置保存失败：" + (e instanceof Error ? e.message : String(e)), "error");
    }
  }, [toast]);

  // ── 基础设置 ────────────────────────────────────────

  function renderBasic() {
    if (loading) return <div className="settings-loading">加载中…</div>;
    return (
      <div className="settings-basic-page">
        <div className="panel-header"><h3>基础设置</h3><p>应用级默认项与通用偏好。</p></div>
        <div className="settings-ffmpeg-section">
          <h4 className="settings-section-title">视频处理引擎</h4>
          {ffmpeg === null ? (
            <div className="settings-ffmpeg-card settings-ffmpeg-card--loading"><span className="spinner"/><span>正在检测…</span></div>
          ) : ffmpeg.available ? (
            <div className="settings-ffmpeg-card settings-ffmpeg-card--ok">
              <div className="settings-ffmpeg-header">
                <div className="settings-ffmpeg-status"><span className="settings-ffmpeg-dot settings-ffmpeg-dot--ok"/><span className="settings-ffmpeg-status-text">FFmpeg 已就绪</span></div>
                <span className="settings-ffmpeg-badge settings-ffmpeg-badge--ok">可用</span>
              </div>
              <div className="settings-ffmpeg-paths">
                <div className="settings-ffmpeg-detail"><span className="settings-ffmpeg-label">ffmpeg</span><span className="settings-ffmpeg-path" title={ffmpeg.ffmpeg_path}>{ffmpeg.ffmpeg_path}</span></div>
                <div className="settings-ffmpeg-detail"><span className="settings-ffmpeg-label">ffprobe</span><span className="settings-ffmpeg-path" title={ffmpeg.ffprobe_path}>{ffmpeg.ffprobe_path}</span></div>
              </div>
              <span className="settings-ffmpeg-desc">视频拼接、归一化、时长探测均可使用。</span>
            </div>
          ) : (
            <div className="settings-ffmpeg-card settings-ffmpeg-card--error">
              <div className="settings-ffmpeg-header">
                <div className="settings-ffmpeg-status"><span className="settings-ffmpeg-dot settings-ffmpeg-dot--error"/><span className="settings-ffmpeg-status-text">FFmpeg 未检测到</span></div>
                <span className="settings-ffmpeg-badge settings-ffmpeg-badge--error">不可用</span>
              </div>
              <span className="settings-ffmpeg-desc">请将 ffmpeg.exe 放入 ffmpeg/ 文件夹。</span>
            </div>
          )}
        </div>
        <div className="settings-basic-grid">
          <div className="summary-card"><span className="settings-summary-label">后续承载</span><strong>项目默认值</strong><small>尺寸、输出目录等。</small></div>
          <div className="summary-card"><span className="settings-summary-label">后续承载</span><strong>运行与缓存</strong><small>超时策略、缓存清理。</small></div>
        </div>
      </div>
    );
  }

  // ── 模型渠道 ────────────────────────────────────────

  function renderModels() {
    if (loading) return <div className="settings-loading">加载中…</div>;

    return (
      <div className="settings-model-page">
        <div className="import-tabs settings-subnav" role="tablist">
          {MODEL_TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              className={`tab-btn settings-subnav-item ${tab === t.key ? "active" : ""}`}
              onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>

        {tab === "text" && (
          <ChannelManager
            list={settings.text} blank={DEFAULT_TEXT_CHANNEL}
            fields={CHANNEL_FIELDS} hasModels
            params={settings.textParams as unknown as Record<string, number>} paramsFields={TEXT_PARAMS_FIELDS}
            onParamsChange={(p) => persist({ ...settingsRef.current, textParams: p as any })}
            onChange={(next) => persist({ ...settingsRef.current, text: next })}
            onPersist={(u) => persist({ ...settingsRef.current, text: u })}
          />
        )}
        {tab === "image" && (
          <ChannelManager
            list={settings.image} blank={DEFAULT_IMAGE_CHANNEL}
            fields={CHANNEL_FIELDS} hasModels
            params={settings.imageParams as unknown as Record<string, number>} paramsFields={IMAGE_PARAMS_FIELDS}
            onParamsChange={(p) => persist({ ...settingsRef.current, imageParams: p as any })}
            onChange={(next) => persist({ ...settingsRef.current, image: next })}
            onPersist={(u) => persist({ ...settingsRef.current, image: u })}
          />
        )}
        {tab === "voice" && (
          <ChannelManager
            list={settings.voice} blank={DEFAULT_VOICE_CHANNEL}
            fields={CHANNEL_FIELDS} hasModels
            params={settings.voiceParams as unknown as Record<string, number>} paramsFields={VOICE_PARAMS_FIELDS}
            onParamsChange={(p) => persist({ ...settingsRef.current, voiceParams: p as any })}
            onChange={(next) => persist({ ...settingsRef.current, voice: next })}
            onPersist={(u) => persist({ ...settingsRef.current, voice: u })}
          />
        )}
        {tab === "video" && (
          <ChannelManager
            list={settings.video} blank={DEFAULT_VIDEO_CHANNEL}
            fields={CHANNEL_FIELDS} hasModels
            resolutionOptions={VIDEO_RESOLUTION_OPTIONS}
            params={settings.videoParams as unknown as Record<string, number>} paramsFields={VIDEO_PARAMS_FIELDS}
            onParamsChange={(p) => persist({ ...settingsRef.current, videoParams: p as any })}
            onChange={(next) => persist({ ...settingsRef.current, video: next })}
            onPersist={(u) => persist({ ...settingsRef.current, video: u })}
          />
        )}
      </div>
    );
  }

  // ── 主体 ────────────────────────────────────────────

  return (
    <div className="modal-backdrop settings-overlay" role="dialog" aria-modal="true" aria-label="应用设置">
      <div className="modal-panel settings-panel settings-panel--shell">
        <div className="modal-header settings-header">
          <div><h2 className="settings-title">设置</h2></div>
          <button type="button" className="icon-button modal-close-button" aria-label="关闭设置" onClick={onClose}>×</button>
        </div>
        <div className="settings-main">
          <aside className="settings-nav" aria-label="设置分类">
            <div className="settings-nav-group">
              {SECTIONS.map((s) => (
                <button key={s.key} type="button" className={`settings-nav-item ${section === s.key ? "active" : ""}`}
                  onClick={() => setSection(s.key)}>
                  <span className="settings-nav-label">{s.label}</span>
                  <span className="settings-nav-hint">{s.hint}</span>
                </button>
              ))}
            </div>
          </aside>
          <div className="settings-body">{section === "basic" ? renderBasic() : renderModels()}</div>
        </div>
        <div className="settings-footer">
          <span className="settings-docs-link" />
          <div className="settings-footer-actions">
            <button type="button" className="primary-button" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
