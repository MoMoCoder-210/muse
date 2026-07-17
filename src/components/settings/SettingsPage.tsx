import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings, saveSettings, getAppVersion, openAppDataDir, openLogDir } from "../../services/tauri";
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

// ── Tab 定义 ──────────────────────────────────────────

type SettingsTab = "general" | "models";

const TABS = [
  { key: "general" as const, label: "通用", icon: "gear" },
  { key: "models" as const, label: "模型", icon: "cpu" },
];

type ModelTab = "text" | "image" | "voice" | "video";

const MODEL_TABS: Array<{ key: ModelTab; label: string }> = [
  { key: "text",  label: "语言模型" },
  { key: "image", label: "生图模型" },
  { key: "voice", label: "语音模型" },
  { key: "video", label: "视频模型" },
];

// ── 渠道级字段 ────────────────────────────────────────

const CHANNEL_FIELDS = [
  { key: "name",   label: "名称",  type: "text" as const,     placeholder: "请输入名称" },
  { key: "apiKey", label: "API Key",  type: "password" as const, placeholder: "请输入Api Key" },
  { key: "baseUrl",label: "Base URL", type: "text" as const,     placeholder: "请输入URL" },
];

const VOICE_FIELDS = [
  { key: "name",       label: "名称",     type: "text" as const,     placeholder: "请输入名称" },
  { key: "apiKey",     label: "API Key", type: "password" as const, placeholder: "火山控制台 语音合成 → API Key" },
  { key: "resourceId", label: "Resource ID", type: "text" as const, placeholder: "如 seed-tts-2.0 或 seed-icl-2.0" },
  { key: "baseUrl",    label: "Base URL", type: "text" as const, placeholder: "https://openspeech.bytedance.com/api/v3/tts/unidirectional" },
];

// ── 全局参数字段 ──────────────────────────────────────

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

// ── 组件 ──────────────────────────────────────────────

type Props = { onClose: () => void };

export function SettingsPage({ onClose }: Props) {
  const { toast } = useToast();
  const [tab, setTab] = useState<SettingsTab>("general");
  const [modelTab, setModelTab] = useState<ModelTab>("text");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const [loading, setLoading] = useState(true);
  const [appVersion, setAppVersion] = useState("unknown");

  useEffect(() => {
    getSettings().then(setSettings).catch(() => toast("读取设置失败", "error")).finally(() => setLoading(false));
    getAppVersion().then(setAppVersion).catch(() => setAppVersion("unknown"));
  }, []);

  const updateState = useCallback((next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const persist = useCallback(async (next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
    try {
      await saveSettings(next);
      toast("已保存", "success");
    } catch (e) {
      toast("设置保存失败：" + (e instanceof Error ? e.message : String(e)), "error");
    }
  }, [toast]);

  // ── SVG 图标 ──────────────────────────────────────

  function TabIcon({ name }: { name: string }) {
    if (name === "gear") return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    );
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2"/>
        <rect x="9" y="9" width="6" height="6"/>
        <line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/>
        <line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>
        <line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/>
        <line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>
      </svg>
    );
  }

  // ── 通用设置 ──────────────────────────────────────

  function renderGeneral() {
    if (loading) return <div className="sk-loading">加载中…</div>;
    return (
      <div className="sk-general">
        {/* 关于 */}
        <div className="sk-group">
          <h4 className="sk-group-title">关于</h4>
          <div className="sk-card">
            <div className="sk-row">
              <span className="sk-row-label">版本</span>
              <span className="sk-row-value">{appVersion}</span>
            </div>
          </div>
        </div>

        {/* 存储 */}
        <div className="sk-group">
          <h4 className="sk-group-title">存储</h4>
          <div className="sk-card sk-card--actions">
            <button type="button" className="sk-action" onClick={() => openAppDataDir().catch(() => toast("打开失败", "error"))}>
              <div className="sk-action-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>
                </svg>
              </div>
              <div className="sk-action-body">
                <span className="sk-action-title">应用数据目录</span>
                <span className="sk-action-desc">设置、工作区与项目缓存</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="sk-action-arrow"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <button type="button" className="sk-action" onClick={() => openLogDir().catch(() => toast("打开失败", "error"))}>
              <div className="sk-action-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>
                </svg>
              </div>
              <div className="sk-action-body">
                <span className="sk-action-title">日志目录</span>
                <span className="sk-action-desc">运行日志与任务日志</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="sk-action-arrow"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── 模型设置 ──────────────────────────────────────

  function renderModels() {
    if (loading) return <div className="sk-loading">加载中…</div>;
    return (
      <div className="sk-models">
        <div className="sk-subnav" role="tablist">
          {MODEL_TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={modelTab === t.key}
              className={`sk-subnav-item${modelTab === t.key ? " active" : ""}`}
              onClick={() => setModelTab(t.key)}>{t.label}</button>
          ))}
        </div>
        <div className="sk-model-content">
          {modelTab === "text" && (
            <ChannelManager
              list={settings.text} blank={DEFAULT_TEXT_CHANNEL}
              fields={CHANNEL_FIELDS} hasModels
              params={settings.textParams as unknown as Record<string, number>} paramsFields={TEXT_PARAMS_FIELDS}
              onParamsChange={(p) => persist({ ...settingsRef.current, textParams: p as any })}
              onChange={(next) => updateState({ ...settingsRef.current, text: next })}
              onPersist={(u) => persist({ ...settingsRef.current, text: u })}
            />
          )}
          {modelTab === "image" && (
            <ChannelManager
              list={settings.image} blank={DEFAULT_IMAGE_CHANNEL}
              fields={CHANNEL_FIELDS} hasModels
              params={settings.imageParams as unknown as Record<string, number>} paramsFields={IMAGE_PARAMS_FIELDS}
              onParamsChange={(p) => persist({ ...settingsRef.current, imageParams: p as any })}
              onChange={(next) => updateState({ ...settingsRef.current, image: next })}
              onPersist={(u) => persist({ ...settingsRef.current, image: u })}
            />
          )}
          {modelTab === "voice" && (
            <ChannelManager
              list={settings.voice} blank={DEFAULT_VOICE_CHANNEL}
              fields={VOICE_FIELDS} hasModels={false} enableTest={false} fixedSingle
              params={settings.voiceParams as unknown as Record<string, number>} paramsFields={VOICE_PARAMS_FIELDS}
              onParamsChange={(p) => persist({ ...settingsRef.current, voiceParams: p as any })}
              onChange={(next) => updateState({ ...settingsRef.current, voice: next })}
              onPersist={(u) => persist({ ...settingsRef.current, voice: u })}
            />
          )}
          {modelTab === "video" && (
            <ChannelManager
              list={settings.video} blank={DEFAULT_VIDEO_CHANNEL}
              fields={CHANNEL_FIELDS} hasModels
              resolutionOptions={VIDEO_RESOLUTION_OPTIONS}
              params={settings.videoParams as unknown as Record<string, number>} paramsFields={VIDEO_PARAMS_FIELDS}
              onParamsChange={(p) => persist({ ...settingsRef.current, videoParams: p as any })}
              onChange={(next) => updateState({ ...settingsRef.current, video: next })}
              onPersist={(u) => persist({ ...settingsRef.current, video: u })}
            />
          )}
        </div>
      </div>
    );
  }

  // ── 主体 ──────────────────────────────────────────

  return (
    <div className="sk-overlay" role="dialog" aria-modal="true" aria-label="应用设置">
      <div className="sk-panel">
        {/* 头部 */}
        <div className="sk-header">
          <h2 className="sk-title">设置</h2>
          <button type="button" className="sk-close" aria-label="关闭设置" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* 顶部 Tab */}
        <div className="sk-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              className={`sk-tab${tab === t.key ? " active" : ""}`}
              onClick={() => setTab(t.key)}>
              <TabIcon name={t.icon} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div className="sk-body">
          {tab === "general" ? renderGeneral() : renderModels()}
        </div>
      </div>
    </div>
  );
}
