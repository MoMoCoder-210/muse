import { useCallback, useEffect, useState } from "react";
import { getSettings, saveSettings } from "../../services/tauri";
import { ModelConfigSection } from "./ModelConfigSection";
import { DEFAULT_SETTINGS, type AppSettings } from "../../types/settings";
import { useToast } from "../../hooks/useToast";

type SettingsSection = "basic" | "models";
type ModelSection = "text" | "image" | "voice";

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
];

const API_FIELDS = [
  {
    key: "apiKey",
    label: "API Key",
    type: "password" as const,
    placeholder: "输入火山方舟 API Key",
  },
  {
    key: "baseUrl",
    label: "Base URL",
    type: "text" as const,
    placeholder: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    key: "model",
    label: "模型 ID",
    type: "text" as const,
    placeholder: "填写方舟模型接入点 ID",
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
    description: "管理语言模型接入所需的密钥、服务地址与模型 ID。",
    fields: API_FIELDS,
  },
  {
    title: "其他参数设置",
    description: "控制文本生成的长度、采样温度与请求超时。",
    fields: [
      TIMEOUT_FIELD,
      {
        key: "maxTokens",
        label: "最大 Token 数",
        type: "number" as const,
        min: 256,
        max: 128000,
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

/**
 * 设置页面
 *
 * 管理应用基础设置与各模型（语言/生图/语音）的 API 配置。
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

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await saveSettings(settings);
      toast("设置已保存。", "success");
    } catch (err) {
      console.error(err);
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
            <p>这里放应用级默认项与通用偏好，不和具体模型接入混在一起。</p>
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
            <div className="summary-card">
              <span className="settings-summary-label">当前状态</span>
              <strong>结构已拆分</strong>
              <small>基础设置与模型设置已经分层，后续可以直接扩展。</small>
            </div>
          </div>
          <div className="empty-panel settings-basic-placeholder">
            这里暂时预留给后续的基础设置项，等我们把真实配置字段补进来。
          </div>
        </div>
      );
    }

    if (activeModelSection === "text") {
      return (
        <div className="settings-model-page">
          {renderModelTabs()}
          <ModelConfigSection<AppSettings["text"]>
            title="语言模型"
            description="用于剧本理解、拆分、提示词生成等文本任务。"
            groups={TEXT_GROUPS}
            values={settings.text}
            onChange={(next) => setSettings((s) => ({ ...s, text: next }))}
          />
        </div>
      );
    }

    if (activeModelSection === "image") {
      return (
        <div className="settings-model-page">
          {renderModelTabs()}
          <ModelConfigSection<AppSettings["image"]>
            title="生图模型"
            description="用于角色、场景、物品资产生成及分镜融合图生成。"
            groups={IMAGE_GROUPS}
            values={settings.image}
            onChange={(next) => setSettings((s) => ({ ...s, image: next }))}
          />
        </div>
      );
    }

    return (
      <div className="settings-model-page">
        {renderModelTabs()}
        <ModelConfigSection<AppSettings["voice"]>
          title="语音模型"
          description="用于分镜旁白与对白的语音合成（TTS）。音色不在这里固定，生成时再选。"
          groups={VOICE_GROUPS}
          values={settings.voice}
          onChange={(next) => setSettings((s) => ({ ...s, voice: next }))}
        />
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
          <a
            className="settings-docs-link"
            href="https://www.volcengine.com/docs/82379"
            target="_blank"
            rel="noopener noreferrer"
          >
            火山方舟文档 ↗
          </a>
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
