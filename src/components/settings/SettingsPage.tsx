import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { getSettings, saveSettings, getAppVersion, openAppDataDir, openLogDir } from "../../services/tauri";
import { ChannelManager } from "./ChannelManager";
import {
  DEFAULT_SETTINGS,
  DEFAULT_TEXT_CHANNEL,
  DEFAULT_IMAGE_CHANNEL,
  DEFAULT_VIDEO_CHANNEL,
  type AppSettings,
} from "../../types/settings";
import { VIDEO_RESOLUTION_OPTIONS } from "../../config/muse";
import { useToast } from "../../hooks/useToast";
import { loadAgentConfig, saveAgentConfig } from "../../services/agent-api";
import type { AgentConfig } from "../../types/agent";

// ── Tab 定义 ──────────────────────────────────────────

type SettingsTab = "general" | "models" | "agent" | "about";

const TABS = [
  { key: "general" as const, label: "通用", icon: "gear" },
  { key: "models" as const, label: "模型", icon: "cpu" },
  { key: "agent" as const, label: "Agent", icon: "robot" },
  { key: "about" as const, label: "关于", icon: "info" },
];

type ModelTab = "text" | "image" | "video";

const MODEL_TABS: Array<{ key: ModelTab; label: string }> = [
  { key: "text",  label: "语言模型" },
  { key: "image", label: "生图模型" },
  { key: "video", label: "视频模型" },
];

// ── 渠道级字段 ────────────────────────────────────────

const CHANNEL_FIELDS = [
  { key: "name",   label: "名称",  type: "text" as const,     placeholder: "请输入名称" },
  { key: "apiKey", label: "API Key",  type: "password" as const, placeholder: "请输入Api Key" },
  { key: "baseUrl",label: "Base URL", type: "text" as const,     placeholder: "请输入URL" },
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
  const [closing, setClosing] = useState(false);
  const clickInsideRef = useRef(false);

  const closeWithAnimation = useCallback(() => {
    setClosing(true);
    // 取 overlay(240ms) 与 panel(260ms) 中较长的 + 缓冲
    setTimeout(() => onClose(), 270);
  }, [onClose]);

  useEffect(() => {
    getSettings().then(setSettings).catch(() => toast("读取设置失败", "error")).finally(() => setLoading(false));
    getAppVersion().then(setAppVersion).catch(() => setAppVersion("unknown"));
  }, [toast]);

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
    if (name === "cpu") return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2"/>
        <rect x="9" y="9" width="6" height="6"/>
        <line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/>
        <line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>
        <line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/>
        <line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>
      </svg>
    );
    if (name === "robot") return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="7" width="18" height="13" rx="2"/>
        <circle cx="12" cy="16" r="1" fill="currentColor"/>
        <path d="M9 2v3M15 2v3M3 12h18"/>
        <line x1="8" y1="12" x2="8" y2="12.01"/>
        <line x1="16" y1="12" x2="16" y2="12.01"/>
      </svg>
    );
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    );
  }

  // ── 通用设置 ──────────────────────────────────────

  function renderGeneral() {
    if (loading) return <div className="sk-loading">加载中…</div>;
    return (
      <div className="sk-general">
        {/* 作品默认位置 */}
        <div className="sk-group">
          <h4 className="sk-group-title">作品</h4>
          <div className="sk-card">
            <div className="sk-row sk-row--input">
              <span className="sk-row-label">默认作品目录</span>
              <div className="sk-inline-input">
                <input
                  className="sk-input"
                  value={settings.general.defaultProjectDir}
                  onChange={(e) => {
                    const next = { ...settingsRef.current, general: { ...settingsRef.current.general, defaultProjectDir: e.target.value } };
                    updateState(next);
                  }}
                  onBlur={() => persist(settingsRef.current)}
                  placeholder="D:\\projects"
                />
                <button
                  type="button"
                  className="sk-browse-btn"
                  onClick={async () => {
                    const selected = await open({ directory: true, multiple: false, title: "选择默认作品目录" });
                    if (typeof selected === "string" && selected.trim()) {
                      const next = { ...settingsRef.current, general: { ...settingsRef.current.general, defaultProjectDir: selected } };
                      await persist(next);
                    }
                  }}
                >
                  选择目录
                </button>
              </div>
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
                <span className="sk-action-title">配置文件目录</span>
                <span className="sk-action-desc">配置文件与软件缓存</span>
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
                <span className="sk-action-desc">软件运行日志</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="sk-action-arrow"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── 关于 ──────────────────────────────────────

  function renderAbout() {
    return (
      <div className="sk-about">
        {/* 应用信息 */}
        <div className="sk-about-hero">
          <div className="sk-about-logo">Muse</div>
          <div className="sk-about-desc">AI 视频创作桌面工具</div>
          <div className="sk-about-version">版本 {appVersion}</div>
        </div>

        {/* 简介 */}
        <div className="sk-group">
          <h4 className="sk-group-title">简介</h4>
          <div className="sk-card">
            <p className="sk-about-text">
              本地优先的 AI 视频创作工具，覆盖从剧本导入到完整视频产出的全链路。
              支持多风格创作（国漫/动漫/日漫/韩漫/二次元/真人），内置人物生图、场景生成、
              镜头编辑、TTS 语音合成与视频拼接导出等完整工作流。
            </p>
          </div>
        </div>

        {/* 链接 */}
        <div className="sk-group">
          <div className="sk-card sk-card--actions">
            <button type="button" className="sk-action" onClick={() => openUrl("https://github.com/MoMoCoder-210/muse/issues")}>
              <div className="sk-action-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <div className="sk-action-body">
                <span className="sk-action-title">报告错误</span>
                <span className="sk-action-desc">在 GitHub Issues 中反馈问题</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="sk-action-arrow"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <button type="button" className="sk-action" onClick={() => openUrl("https://github.com/MoMoCoder-210/muse")}>
              <div className="sk-action-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </div>
              <div className="sk-action-body">
                <span className="sk-action-title">给项目加星</span>
                <span className="sk-action-desc">在 GitHub 上支持我们</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="sk-action-arrow"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>

        {/* 版权（页面最下方） */}
        <div className="sk-group">
          <div className="sk-card">
            <p className="sk-about-copyright">
              Muse AI 视频创作工具<br/>
              Built with Tauri · React · Rust · SQLite
            </p>
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
              fields={CHANNEL_FIELDS} hasModels channelType="text"
              onChange={(next) => updateState({ ...settingsRef.current, text: next as unknown as AppSettings["text"] })}
              onPersist={(u) => persist({ ...settingsRef.current, text: u as unknown as AppSettings["text"] })}
            />
          )}
          {modelTab === "image" && (
            <ChannelManager
              list={settings.image} blank={DEFAULT_IMAGE_CHANNEL}
              fields={CHANNEL_FIELDS} hasModels channelType="image"
              onChange={(next) => updateState({ ...settingsRef.current, image: next as unknown as AppSettings["image"] })}
              onPersist={(u) => persist({ ...settingsRef.current, image: u as unknown as AppSettings["image"] })}
            />
          )}
          {modelTab === "video" && (
            <ChannelManager
              list={settings.video} blank={DEFAULT_VIDEO_CHANNEL}
              fields={CHANNEL_FIELDS} hasModels channelType="video"
              resolutionOptions={VIDEO_RESOLUTION_OPTIONS}
              onChange={(next) => updateState({ ...settingsRef.current, video: next as unknown as AppSettings["video"] })}
              onPersist={(u) => persist({ ...settingsRef.current, video: u as unknown as AppSettings["video"] })}
            />
          )}
        </div>
      </div>
    );
  }

  // ── Agent 设置 ──────────────────────────────────────

  function AgentConfigForm() {
    const [agentConfig, setAgentConfig] = useState<AgentConfig>({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "",
      baseUrl: "",
    });
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      loadAgentConfig().then((c) => { if (c) setAgentConfig(c); });
    }, []);

    const handleSave = async () => {
      setSaving(true);
      try {
        await saveAgentConfig(agentConfig);
        toast("Agent 配置已保存", "success");
      } catch {
        toast("保存失败", "error");
      } finally {
        setSaving(false);
      }
    };

    return (
      <div className="agent-config">
        <div className="agent-config__card">
          <div className="agent-config__group">
            <label className="agent-config__label">AI 服务商</label>
            <select
              className="agent-config__select"
              value={agentConfig.provider}
              onChange={(e) => setAgentConfig({ ...agentConfig, provider: e.target.value as "openai" | "anthropic" })}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic (Claude)</option>
            </select>
          </div>
          <div className="agent-config__group">
            <label className="agent-config__label">模型</label>
            <input
              className="agent-config__input"
              type="text"
              value={agentConfig.model}
              onChange={(e) => setAgentConfig({ ...agentConfig, model: e.target.value })}
              placeholder="gpt-4o"
            />
          </div>
          <div className="agent-config__group">
            <label className="agent-config__label">API Key</label>
            <input
              className="agent-config__input"
              type="password"
              value={agentConfig.apiKey}
              onChange={(e) => setAgentConfig({ ...agentConfig, apiKey: e.target.value })}
              placeholder="sk-..."
            />
          </div>
          <div className="agent-config__group">
            <label className="agent-config__label">Base URL（可选，自定义端点）</label>
            <input
              className="agent-config__input"
              type="text"
              value={agentConfig.baseUrl ?? ""}
              onChange={(e) => setAgentConfig({ ...agentConfig, baseUrl: e.target.value || undefined })}
              placeholder="留空使用默认地址"
            />
          </div>
          <button
            type="button"
            className="agent-config__save-btn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存配置"}
          </button>
          <p className="agent-config__hint">
            API Key 仅存储在你的本地电脑上，不会上传到任何服务器。
          </p>
        </div>
      </div>
    );
  }

  function renderAgent() {
    return (
      <div className="sk-general">
        <div className="sk-group">
          <h4 className="sk-group-title">AI Agent 配置</h4>
          <AgentConfigForm />
        </div>
      </div>
    );
  }

  // ── 主体 ──────────────────────────────────────────

  return (
      <div
        className={`sk-overlay${closing ? " sk-overlay--closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="应用设置"
        onMouseDown={(e) => {
          clickInsideRef.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (clickInsideRef.current && e.target === e.currentTarget) closeWithAnimation();
        }}
      >
      <div className={`sk-panel${closing ? " sk-panel--closing" : ""}`}>
        {/* 头部 */}
        <div className="sk-header">
          <h2 className="sk-title">设置</h2>
          <button type="button" className="sk-close" aria-label="关闭设置" onClick={closeWithAnimation}>
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
          {tab === "general" ? renderGeneral() : tab === "models" ? renderModels() : tab === "agent" ? renderAgent() : renderAbout()}
        </div>
      </div>
    </div>
  );
}
