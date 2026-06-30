import { useCallback, useEffect, useState } from "react";
import { message } from "@tauri-apps/plugin-dialog";
import { getSettings, saveSettings } from "../../services/tauri";
import { ModelConfigSection } from "./ModelConfigSection";
import { DEFAULT_SETTINGS, type AppSettings } from "../../types/settings";
import { APP_NAME } from "../../config/muse";

type SettingsTab = "text" | "image" | "voice";

const TAB_LABELS: Record<SettingsTab, string> = {
  text:  "文本模型",
  image: "生图模型",
  voice: "语音模型",
};

type SettingsPageProps = {
  onClose: () => void;
};

export function SettingsPage({ onClose }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("text");
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
      await message("设置已保存。", { title: APP_NAME, kind: "info" });
    } catch (err) {
      console.error(err);
      await message("保存失败，请检查后端日志。", { title: APP_NAME, kind: "error" });
    } finally {
      setSaving(false);
    }
  }, [settings]);

  // 关闭前提示未保存（简单处理：不阻断，仅提示）
  function handleClose() {
    onClose();
  }

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="应用设置">
      <div className="settings-panel">

        {/* 头部 */}
        <div className="settings-header">
          <div>
            <h2 className="settings-title">设置</h2>
            <p className="settings-subtitle">模型接入与 API 配置</p>
          </div>
          <button
            type="button"
            className="icon-button modal-close-button"
            aria-label="关闭设置"
            onClick={handleClose}
          >
            ×
          </button>
        </div>

        {/* Tab 导航 */}
        <div className="settings-tabs" role="tablist">
          {(Object.keys(TAB_LABELS) as SettingsTab[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`settings-tab-btn ${tab === key ? "active" : ""}`}
              onClick={() => setTab(key)}
            >
              {TAB_LABELS[key]}
              {/* 未配置 apiKey 时显示红点提醒 */}
              {!settings[key].apiKey && (
                <span className="settings-tab-dot" aria-label="未配置" />
              )}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div className="settings-body">
          {loading ? (
            <div className="settings-loading">加载中…</div>
          ) : (
            <>
              {tab === "text" && (
                <ModelConfigSection
                  title="文本模型"
                  description="用于剧本理解、拆分、提示词生成等文本任务。接入火山方舟豆包系列模型。"
                  fields={TEXT_FIELDS}
                  values={settings.text as unknown as Record<string, unknown>}
                  onChange={(next) =>
                    setSettings((s) => ({ ...s, text: next as typeof s.text }))
                  }
                />
              )}
              {tab === "image" && (
                <ModelConfigSection
                  title="生图模型"
                  description="用于角色、场景、物品资产生成及分镜融合图生成。接入火山方舟豆包生图模型。"
                  fields={IMAGE_FIELDS}
                  values={settings.image as unknown as Record<string, unknown>}
                  onChange={(next) =>
                    setSettings((s) => ({ ...s, image: next as typeof s.image }))
                  }
                />
              )}
              {tab === "voice" && (
                <ModelConfigSection
                  title="语音模型"
                  description="用于分镜旁白与对白的语音合成（TTS）。接入火山方舟豆包 TTS。"
                  fields={VOICE_FIELDS}
                  values={settings.voice as unknown as Record<string, unknown>}
                  onChange={(next) =>
                    setSettings((s) => ({ ...s, voice: next as typeof s.voice }))
                  }
                />
              )}
            </>
          )}
        </div>

        {/* 底部操作 */}
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
            <button type="button" className="ghost-button" onClick={handleClose}>
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

// ── 字段定义 ──────────────────────────────────────────────

const COMMON_FIELDS = [
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
  {
    key: "timeoutMs",
    label: "超时（毫秒）",
    type: "number" as const,
    min: 5000,
    max: 600000,
    step: 1000,
  },
];

const TEXT_FIELDS = [
  ...COMMON_FIELDS,
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
];

const IMAGE_FIELDS = [
  ...COMMON_FIELDS,
  {
    key: "size",
    label: "输出尺寸",
    type: "text" as const,
    placeholder: "如 1024x1024 / 2K / 4K",
  },
];

const VOICE_FIELDS = [
  ...COMMON_FIELDS,
  {
    key: "voice",
    label: "音色 ID",
    type: "text" as const,
    placeholder: "如 zh_female_shuangkuaisisi_moon_bigtts",
  },
  {
    key: "speed",
    label: "语速",
    type: "number" as const,
    min: 0.5,
    max: 2.0,
    step: 0.1,
  },
];
