/**
 * 模型渠道管理器（语言 / 生图 / 语音 / 素材）
 *
 * 负责渠道的增删改、模型 ID 管理、连通性测试与全局参数编辑。
 * 变更通过 onPersist 即时持久化，由父组件 SettingsPage 统一写盘。
 *
 * @author yt @date 20260710
 */

import { useState, useCallback } from "react";
import { generateId, type ChannelList } from "../../types/settings";
import { testConnection } from "../../services/tauri";

// ── 类型 ────────────────────────────────────────────────

interface ChannelEditor {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  models: Array<{ id: string; modelId: string }>;
  activeModelId: string;
}

type FieldDef = { key: string; label: string; type: "text" | "password" | "number"; placeholder?: string };

interface ChannelManagerProps<T extends { id: string; name: string }> {
  list: ChannelList<T>;
  blank: T;
  fields: FieldDef[];
  hasModels: boolean;
  params: Record<string, any>;
  paramsFields: Array<{ key: string; label: string; type: "number"; min?: number; max?: number; step?: number }>;
  onParamsChange: (params: Record<string, any>) => void;
  onChange: (next: ChannelList<T>) => void;
  /** 新增/编辑/删除后立即持久化 */
  onPersist: (updated: ChannelList<T>) => void;
}

// ── 工具 ────────────────────────────────────────────────

/** 由 blank 模板生成空白编辑态表单（hasModels 仅为保持调用签名一致，函数内不依赖） */
function emptyForm(blank: any, _hasModels: boolean): ChannelEditor {
  return {
    id: "", name: "",
    apiKey: blank.apiKey ?? "", baseUrl: blank.baseUrl ?? "",
    models: [],
    activeModelId: "",
  };
}

// ── 组件 ────────────────────────────────────────────────

export function ChannelManager<T extends { id: string; name: string }>({
  list, blank, fields, hasModels,
  params, paramsFields, onParamsChange,
  onChange, onPersist,
}: ChannelManagerProps<T>) {
  const [form, setForm] = useState<ChannelEditor>(() => emptyForm(blank, hasModels));
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState("");
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<{ ok: boolean; message: string } | null>(null);

  const channels = list.channels;
  const isEditing = !!form.id;
  const showForm = formOpen || channels.length === 0;

  // ── 参数 ──────────────────────────────────────────

  const updateParam = useCallback(
    (key: string, raw: string) => onParamsChange({ ...params, [key]: Number(raw) }),
    [params, onParamsChange],
  );

  // ── 表单 ──────────────────────────────────────────

  const updateField = useCallback(
    (key: string, raw: string) => setForm((prev) => ({ ...prev, [key]: raw })),
    [],
  );

  const addModel = useCallback(() => {
    const id = newModelId.trim();
    if (!id) return;
    setForm((prev) => {
      const m = { id: generateId(), modelId: id };
      return { ...prev, models: [...prev.models, m], activeModelId: prev.activeModelId || m.id };
    });
    setNewModelId("");
  }, [newModelId]);

  const delModel = useCallback((mid: string) => {
    setForm((prev) => {
      const models = prev.models.filter((m) => m.id !== mid);
      return { ...prev, models, activeModelId: prev.activeModelId === mid ? (models[0]?.id ?? "") : prev.activeModelId };
    });
  }, []);

  // ── 新增 / 编辑 ───────────────────────────────────

  const openAdd = useCallback(() => {
    setForm(emptyForm(blank, hasModels));
    setFormOpen(true);
    setTestState(null);
  }, [blank, hasModels]);

  const handleAdd = useCallback(() => {
    const newCh = {
      ...(blank as any),
      id: generateId(),
      name: form.name || `渠道 ${channels.length + 1}`,
      apiKey: form.apiKey, baseUrl: form.baseUrl,
      ...(hasModels ? { models: form.models, activeModelId: form.activeModelId } : {}),
    } as T;
    const updated = { channels: [...channels, newCh], activeId: newCh.id };
    onChange(updated);
    onPersist(updated);
    setForm(emptyForm(blank, hasModels));
    setFormOpen(false);
  }, [form, blank, channels, hasModels, onChange, onPersist]);

  const startEdit = useCallback((ch: any) => {
    setForm({
      id: ch.id, name: ch.name, apiKey: ch.apiKey, baseUrl: ch.baseUrl,
      models: hasModels ? (ch.models ?? []).map((m: any) => ({ id: m.id, modelId: m.modelId })) : [],
      activeModelId: hasModels ? (ch.activeModelId ?? ch.models?.[0]?.id ?? "") : "",
    });
    setFormOpen(true);
    setTestState(null);
  }, [hasModels]);

  const handleSave = useCallback(() => {
    const updated = {
      ...list,
      channels: channels.map((ch: any) =>
        ch.id === form.id ? { ...ch, name: form.name, apiKey: form.apiKey, baseUrl: form.baseUrl,
          ...(hasModels ? { models: form.models, activeModelId: form.activeModelId } : {}) } : ch,
      ),
    };
    onChange(updated);
    onPersist(updated);
    setForm(emptyForm(blank, hasModels));
    setFormOpen(false);
  }, [form, blank, channels, hasModels, onChange, list, onPersist]);

  const cancel = useCallback(() => {
    setForm(emptyForm(blank, hasModels));
    setFormOpen(false);
    setTestState(null);
  }, [blank, hasModels]);

  const handleTest = useCallback(async () => {
    if (!form.apiKey.trim() || !form.baseUrl.trim()) return;
    setTesting(true);
    setTestState(null);
    try {
      const res = await testConnection({ apiKey: form.apiKey.trim(), baseUrl: form.baseUrl.trim() });
      setTestState({ ok: res.ok, message: res.message });
    } catch (e) {
      setTestState({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }, [form.apiKey, form.baseUrl]);

  // ── 列表 ──────────────────────────────────────────

  const switchActive = useCallback(
    (id: string) => { if (id !== list.activeId) onChange({ ...list, activeId: id }); },
    [list, onChange],
  );

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    const remaining = channels.filter((c: any) => c.id !== deleteTarget);
    const newActiveId = list.activeId === deleteTarget ? (remaining[0] as any)?.id ?? "" : list.activeId;
    const updated = { channels: remaining, activeId: newActiveId };
    onChange(updated);
    onPersist(updated);
    setDeleteTarget(null);
    if (form.id === deleteTarget) { setForm(emptyForm(blank, hasModels)); setFormOpen(false); }
  }, [deleteTarget, channels, list.activeId, onChange, onPersist, form.id, blank, hasModels]);

  // ── 渲染 ──────────────────────────────────────────

  return (
    <div className="channel-manager-v2">

      {/* ══ 渠道列表（主视图） ════════════════════ */}
      <div className="cm-section">
        <div className="cm-section-header">
          <span className="cm-section-title">渠道列表 ({channels.length})</span>
        </div>

        {channels.length === 0 ? (
          <div className="cm-form-placeholder">暂无渠道，点击下方「新增渠道」开始添加</div>
        ) : (
          <div className="cm-channel-list">
            {channels.map((ch: any) => {
              const isActive = ch.id === list.activeId;
              const host = extractHost(ch.baseUrl);
              const modelCount = hasModels ? (ch.models?.length ?? 0) : 0;
              const hasKey = !!ch.apiKey?.trim();
              return (
                <div key={ch.id} className={`cm-channel-row ${isActive ? "cm-channel-row--active" : ""}`}>
                  <button type="button" className="cm-channel-row-main"
                    onClick={() => startEdit(ch)} title="点击编辑渠道">
                    <span className={`cm-channel-dot ${isActive ? "cm-channel-dot--on" : ""} ${hasKey ? "cm-channel-dot--keyed" : ""}`} />
                    <span className="cm-channel-name">{ch.name}</span>
                    {host && <span className="cm-channel-url">{host}</span>}
                    {hasModels && <span className="cm-channel-meta">{modelCount} 个模型</span>}
                    {isActive && <span className="cm-channel-badge">当前使用</span>}
                  </button>
                  <div className="cm-channel-row-actions">
                    {!isActive && (
                      <button type="button" className="cm-channel-action-btn"
                        onClick={() => switchActive(ch.id)} title="设为默认渠道">设为默认</button>
                    )}
                    <button type="button" className="cm-channel-action-btn cm-channel-action-btn--danger"
                      disabled={channels.length <= 1}
                      title={channels.length <= 1 ? "至少保留一个渠道" : "删除该渠道"}
                      onClick={() => setDeleteTarget(ch.id)}>删除</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ══ 新增 / 编辑表单（默认折叠） ═════════════ */}
      <div className="cm-section">
        {!showForm ? (
          <button type="button" className="cm-add-trigger" onClick={openAdd}>+ 新增渠道</button>
        ) : (
          <>
            <div className="cm-section-header">
              <span className="cm-section-title">
                {isEditing ? `编辑渠道 · ${form.name || "未命名"}` : "新增渠道"}
              </span>
            </div>

            <div className="cm-form-card">
              <div className="cm-fields">
                {fields.map((f) => (
                  <label key={f.key} className="cm-field">
                    <span className="cm-field-label">{f.label}</span>
                    <input
                      type={f.type}
                      className="cm-field-input"
                      value={String((form as any)[f.key] ?? "")}
                      onChange={(e) => updateField(f.key, e.target.value)}
                      placeholder={f.placeholder}
                    />
                  </label>
                ))}
                {hasModels && (
                  <label className="cm-field">
                    <span className="cm-field-label">模型 ID</span>
                    <div className="cm-field-input-group">
                      <input
                        type="text"
                        className="cm-field-input cm-field-input--group"
                        value={newModelId}
                        onChange={(e) => setNewModelId(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") addModel(); }}
                        placeholder="输入后回车或点击添加"
                      />
                      <button type="button" className="cm-field-add-btn" onClick={addModel} disabled={!newModelId.trim()}>
                        添加
                      </button>
                    </div>
                  </label>
                )}
              </div>

              {hasModels && form.models.length > 0 && (
                <div className="cm-model-tags">
                  {form.models.map((m) => {
                    const active = m.id === form.activeModelId;
                    return (
                      <span
                        key={m.id}
                        className={`cm-model-tag ${active ? "cm-model-tag--active" : ""}`}
                        onClick={() => setForm((prev) => ({ ...prev, activeModelId: m.id }))}
                        title={active ? "当前使用模型" : "点击设为使用模型"}
                      >
                        <span className="cm-model-tag-text">{m.modelId}</span>
                        {active && <span className="cm-model-tag-badge">使用中</span>}
                        <button
                          type="button"
                          className="cm-model-tag-del"
                          onClick={(e) => { e.stopPropagation(); delModel(m.id); }}
                          title="删除"
                        >×</button>
                      </span>
                    );
                  })}
                </div>
              )}

              <div className="cm-form-footer">
                <div className="cm-test-row">
                  <button type="button" className="cm-test-btn"
                    onClick={handleTest}
                    disabled={testing || !form.apiKey.trim() || !form.baseUrl.trim()}>
                    {testing ? "测试中…" : "测试连接"}
                  </button>
                  {testState && (
                    <span className={`cm-test-result ${testState.ok ? "is-ok" : "is-err"}`}>{testState.message}</span>
                  )}
                </div>

                <div className="cm-form-actions">
                  <button type="button" className="ghost-button" onClick={cancel}>取消</button>
                  <button type="button" className="primary-button" onClick={isEditing ? handleSave : handleAdd}>
                    {isEditing ? "保存" : "新增"}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ══ 全局参数 ══════════════════════════════ */}
      <div className="cm-section">
        <div className="cm-section-header">
          <span className="cm-section-title">全局参数</span>
        </div>
        <div className="cm-params-card">
          {paramsFields.map((f) => (
            <label key={f.key} className="cm-field">
              <span className="cm-field-label">{f.label}</span>
              <input
                type="number"
                className="cm-field-input"
                value={String(params[f.key] ?? "")}
                onChange={(e) => updateParam(f.key, e.target.value)}
                min={f.min} max={f.max} step={f.step}
              />
            </label>
          ))}
        </div>
      </div>

      {/* 删除确认 */}
      {deleteTarget && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setDeleteTarget(null)}>
          <div className="modal-panel clip-delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="delete-confirm-title">删除渠道</h2>
              <button type="button" className="icon-button modal-close-button" aria-label="关闭" onClick={() => setDeleteTarget(null)}>×</button>
            </div>
            <p className="clip-delete-modal-text">
              确认删除渠道 <strong>「{channels.find((c: any) => c.id === deleteTarget)?.name ?? ""}」</strong>？此操作不可撤销。
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary-button btn-sm" onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="danger-button btn-sm" onClick={confirmDelete}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 从 URL 提取 host 用于列表展示，解析失败则原样返回 */
function extractHost(url: string): string {
  if (!url) return "";
  try { return new URL(url).hostname; }
  catch { const m = url.match(/https?:\/\/([^\/\s]+)/); return m ? m[1] : url; }
}
