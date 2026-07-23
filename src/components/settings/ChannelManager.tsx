/**
 * 模型渠道管理器（语言 / 生图 / 语音 / 视频 / 素材）
 */

import { useState, useCallback } from "react";
import { generateId, type ChannelList } from "../../types/settings";
import { testConnection, checkChannelPendingTasks } from "../../services/tauri";
import { useToast } from "../../hooks/useToast";

// ── 类型 ────────────────────────────────────────────────

interface ChannelEditor {
  id: string;
  name: string;
  models: Array<{ id: string; modelId: string; resolutions?: string[] }>;
  activeModelId: string;
  // 其余字段（apiKey / baseUrl / appId / accessKey / resourceId ...）由 fields 动态驱动
  [k: string]: any;
}

type FieldDef = { key: string; label: string; type: "text" | "password" | "number"; placeholder?: string };

/** 渠道通用形状：所有渠道至少含 id/name，模型类渠道含可选 models */
interface ChannelLike {
  id: string;
  name: string;
  apiKey?: string;
  baseUrl?: string;
  models?: Array<{ id: string; modelId: string; resolutions?: string[] }>;
  activeModelId?: string;
  // 其余字段由 fields 动态驱动
  [k: string]: any;
}

interface ChannelManagerProps<T extends ChannelLike> {
  list: ChannelList<T>;
  blank: T;
  fields: FieldDef[];
  hasModels: boolean;
  /** 视频类渠道传入可选分辨率选项，渲染「按模型配置支持分辨率」；不传则仅管理模型 ID */
  resolutionOptions?: readonly string[];
  /** 渠道类型，删除时据此检查对应任务队列 */ 
  channelType: "text" | "image" | "video";
  onChange: (next: ChannelList<T>) => void;
  /** 新增/编辑/删除后立即持久化 */
  onPersist: (updated: ChannelList<T>) => void;
  /** 是否显示「测试连接」按钮；语音（V3）等无 OpenAI /models 探测的渠道置 false */
  enableTest?: boolean;
  /** 顶部说明文案（如语音渠道的协议提示） */
  note?: string;
  /** 固定单渠道（不可新增/删除/切换默认，名称锁定）。语音等只能接入指定服务时使用 */
  fixedSingle?: boolean;
}

// ── 工具 ────────────────────────────────────────────────

/** 由 blank 模板生成空白编辑态表单 */
function emptyForm<T extends ChannelLike>(_blank: T): ChannelEditor {
  return {
    id: "", name: "",
    models: [],
    activeModelId: "",
  };
}

// ── 组件 ────────────────────────────────────────────────

export function ChannelManager<T extends ChannelLike>({
  list, blank, fields, hasModels, resolutionOptions,
  channelType, onChange, onPersist, enableTest = true, note, fixedSingle = false,
}: ChannelManagerProps<T>) {
  const { toast } = useToast();
  const [form, setForm] = useState<ChannelEditor>(() => emptyForm(blank));
  // 展开的渠道 id；"__new__" 表示展开「新增渠道」面板；null 表示全部收起
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState("");
  // 添加模型时选定的支持分辨率；默认不选中，添加后锁定不可再改
  const [newModelRes, setNewModelRes] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<{ ok: boolean; message: string } | null>(null);

  const channels = list.channels;

  // ── 表单 ──────────────────────────────────────────

  const updateField = useCallback(
    (key: string, raw: string) => setForm((prev) => ({ ...prev, [key]: raw })),
    [],
  );

  const addModel = useCallback(() => {
    const id = newModelId.trim();
    if (!id) return;
    if (resolutionOptions && newModelRes.length === 0) {
      toast("请至少选择一个支持分辨率", "error");
      return;
    }
    const res = [...newModelRes];
    setForm((prev) => {
      const m = { id: generateId(), modelId: id, resolutions: res };
      return { ...prev, models: [...prev.models, m], activeModelId: prev.activeModelId || m.id };
    });
    setNewModelId("");
    // 添加后重置为空，下一个模型需显式勾选分辨率
    setNewModelRes([]);
  }, [newModelId, newModelRes, resolutionOptions, toast]);

  const delModel = useCallback((mid: string) => {
    setForm((prev) => {
      const models = prev.models.filter((m) => m.id !== mid);
      return { ...prev, models, activeModelId: prev.activeModelId === mid ? (models[0]?.id ?? "") : prev.activeModelId };
    });
  }, []);

  // ── 新增 / 编辑（行内展开） ─────────────────────

  const startEdit = useCallback((ch: T) => {
    const init: ChannelEditor = {
      id: ch.id, name: ch.name,
      models: hasModels ? (ch.models ?? []).map((m: any) => ({ id: m.id, modelId: m.modelId, resolutions: m.resolutions ?? [] })) : [],
      activeModelId: hasModels ? (ch.activeModelId ?? ch.models?.[0]?.id ?? "") : "",
    };
    // 复制动态字段（apiKey / appId / accessKey / resourceId / baseUrl ...）
    for (const f of fields) (init as any)[f.key] = (ch as any)[f.key] ?? "";
    setForm(init);
    setTestState(null);
  }, [hasModels, fields]);

  /** 点击渠道行：展开其编辑面板；再次点击同一行则收起 */
  const toggleExpand = useCallback((ch: T) => {
    if (expandedId === ch.id) {
      setExpandedId(null);
      setTestState(null);
    } else {
      startEdit(ch);
      setExpandedId(ch.id);
    }
  }, [expandedId, startEdit]);

  const openAdd = useCallback(() => {
    setForm(emptyForm(blank));
    setExpandedId("__new__");
    setTestState(null);
  }, [blank, hasModels]);

  const getFormValidationError = useCallback((): string | null => {
    for (const field of fields) {
      if (!String((form as any)[field.key] ?? "").trim()) {
        return `请填写${field.label}`;
      }
    }
    if (hasModels && form.models.length === 0) {
      return "请至少添加一个模型 ID";
    }
    if (resolutionOptions && hasModels) {
      const modelWithoutResolution = form.models.find((model) => !(model.resolutions ?? []).length);
      if (modelWithoutResolution) {
        return `模型 ${modelWithoutResolution.modelId} 未选择分辨率`;
      }
    }
    return null;
  }, [fields, form, hasModels, resolutionOptions]);

  const validateForm = useCallback(() => {
    const error = getFormValidationError();
    if (error) toast(error, "error");
    return !error;
  }, [getFormValidationError, toast]);

  const handleAdd = useCallback(() => {
    if (!validateForm()) return;

    const newCh: any = { ...blank, id: generateId(), name: form.name || `渠道 ${channels.length + 1}` };
    for (const f of fields) newCh[f.key] = (form as any)[f.key] ?? "";
    if (hasModels) { newCh.models = form.models; newCh.activeModelId = form.activeModelId; }
    const updated = { channels: [...channels, newCh], activeId: channels.length === 0 ? newCh.id : list.activeId };
    onChange(updated);
    onPersist(updated);
    setForm(emptyForm(blank));
    setExpandedId(null);
  }, [form, blank, channels, hasModels, fields, onChange, onPersist, validateForm]);

  const handleSave = useCallback(() => {
    if (!validateForm()) return;

    const updated = {
      ...list,
      channels: channels.map((ch: T) =>
        ch.id === form.id
          ? (() => {
              const u: any = { ...ch, name: form.name };
              for (const f of fields) u[f.key] = (form as any)[f.key] ?? "";
              if (hasModels) { u.models = form.models; u.activeModelId = form.activeModelId; }
              return u;
            })()
          : ch,
      ),
    };
    onChange(updated);
    onPersist(updated);
    setForm(emptyForm(blank));
    setExpandedId(null);
  }, [form, blank, channels, hasModels, fields, onChange, list, onPersist, validateForm]);

  const cancel = useCallback(() => {
    setForm(emptyForm(blank));
    setExpandedId(null);
    setTestState(null);
  }, [blank, hasModels]);

  /** 编辑/新增表单主体（字段 + 模型区），供行内面板复用 */
  const renderEditorBody = () => (
    <>
      <div className="cm-fields">
        {fields.map((f) => (
          <label key={f.key} className="cm-field">
            <span className="cm-field-label">{f.label}</span>
            {fixedSingle && f.key === "name" ? (
              <input className="cm-field-input" value="火山语音（OpenSpeech V3）" disabled readOnly />
            ) : (
              <input
                type={f.type}
                className="cm-field-input"
                value={String((form as any)[f.key] ?? "")}
                onChange={(e) => updateField(f.key, e.target.value)}
                placeholder={f.placeholder}
              />
            )}
          </label>
        ))}
      </div>

      {hasModels && (
        <div className="cm-model-zone">
          <label className="cm-field cm-field--model-id">
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
              <button type="button" className="cm-field-add-btn" onClick={addModel} disabled={!newModelId.trim() || (!!resolutionOptions && newModelRes.length === 0)}>
                添加
              </button>
            </div>
          </label>

          {resolutionOptions && (
            <div className="cm-new-res">
              <div className="cm-new-res-head">
                <span className="cm-model-res-label">支持分辨率</span>
              </div>
              <div className="cm-res-picker">
                {resolutionOptions.map((r) => {
                  const on = newModelRes.includes(r);
                  return (
                    <button key={r} type="button"
                      className={`cm-res-chip ${on ? "cm-res-chip--on" : ""}`}
                      onClick={() => setNewModelRes((prev) => prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r])}
                      aria-pressed={on}
                      title={on ? `取消 ${r}` : `添加 ${r}`}>
                      {on && <span className="cm-res-check">✓</span>}
                      {r}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {form.models.length > 0 && (
            resolutionOptions ? (
              <div className="cm-model-res-list">
                {form.models.map((m) => {
                  const active = m.id === form.activeModelId;
                  const selected = m.resolutions ?? [];
                  return (
                    <div key={m.id} className={`cm-model-res ${active ? "cm-model-res--active" : ""}`}>
                      <div className="cm-model-res-head">
                        <span className="cm-model-res-name">{m.modelId}</span>
                        {active && <span className="cm-model-tag-badge">使用中</span>}
                        <div className="cm-model-res-actions">
                          {!active && (
                            <button type="button" className="cm-model-res-set"
                              onClick={() => setForm((prev) => ({ ...prev, activeModelId: m.id }))}>设为使用</button>
                          )}
                          <button type="button" className="cm-model-tag-del"
                            onClick={(e) => { e.stopPropagation(); delModel(m.id); }} title="删除">×</button>
                        </div>
                      </div>
                      <div className="cm-model-res-opts">
                        <span className="cm-model-res-label">支持分辨率</span>
                        <div className="cm-model-res-chips">
                          {selected.length > 0 ? (
                            selected.map((r) => (
                              <span key={r} className="cm-res-chip cm-res-chip--ro">{r}</span>
                            ))
                          ) : (
                            <span className="cm-res-none">未配置</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
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
            )
          )}
        </div>
      )}
    </>
  );

  /** 表单底部（测试连接 + 操作按钮），mode 区分保存/新增 */
  const renderEditorFooter = (mode: "edit" | "add") => {
    const disabled = getFormValidationError() !== null;

    return (
    <div className="cm-form-footer">
      {enableTest && (
        <div className="cm-test-row">
          <button type="button" className="cm-test-btn"
            onClick={handleTest}
            disabled={testing || fields.some((f) => !(form as any)[f.key]?.trim())}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          {testState && (
            <span className={`cm-test-result ${testState.ok ? "is-ok" : "is-err"}`}>{testState.message}</span>
          )}
        </div>
      )}

      <div className="cm-form-actions">
        <button type="button" className="ghost-button" onClick={cancel}>
          {mode === "edit" ? "收起" : "取消"}
        </button>
        <button type="button" className="primary-button" onClick={mode === "edit" ? handleSave : handleAdd} disabled={disabled}>
          {mode === "edit" ? "保存" : "新增"}
        </button>
      </div>
    </div>
    );
  };

  const handleTest = useCallback(async () => {
    const apiKey = (form as any).apiKey ?? "";
    const baseUrl = (form as any).baseUrl ?? "";
    if (!String(apiKey).trim() || !String(baseUrl).trim()) return;
    setTesting(true);
    setTestState(null);
    try {
      const res = await testConnection({ apiKey: String(apiKey).trim(), baseUrl: String(baseUrl).trim() });
      setTestState({ ok: res.ok, message: res.message });
    } catch (e) {
      setTestState({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }, [form]);

  // ── 列表 ──────────────────────────────────────────

  const switchActive = useCallback(
    (id: string) => {
      if (id === list.activeId) return;
      const updated = { ...list, activeId: id };
      onChange(updated);
      onPersist(updated);
    },
    [list, onChange, onPersist],
  );

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    const remaining = channels.filter((c: T) => c.id !== deleteTarget);
    const newActiveId = list.activeId === deleteTarget ? (remaining[0] as any)?.id ?? "" : list.activeId;
    const updated = { channels: remaining, activeId: newActiveId };
    onChange(updated);
    onPersist(updated);
    setDeleteTarget(null);
    if (form.id === deleteTarget) { setForm(emptyForm(blank)); setExpandedId(null); }
  }, [deleteTarget, channels, list.activeId, onChange, onPersist, form.id, blank, hasModels]);

  // ── 渲染 ──────────────────────────────────────────

  return (
    <div className="cm">

      {note && <div className="cm-note">{note}</div>}

      {/* ══ 渠道列表（点击行展开/收起编辑） ══════ */}
      <div className="cm-channels-card">

        {channels.length === 0 ? (
          <div className="cm-form-placeholder">暂无渠道，点击下方「新增渠道」开始添加</div>
        ) : (
          channels.map((ch: T) => {
            const isActive = ch.id === list.activeId;
            const expanded = expandedId === ch.id;
            const host = extractHost(ch.baseUrl ?? "");
            const modelCount = hasModels ? (ch.models?.length ?? 0) : 0;
            const hasKey = !!((ch.apiKey ?? "")?.trim());
            return (
              <div key={ch.id} className={`cm-channel-item ${isActive ? "cm-channel-item--active" : ""}`}>
                <div className={`cm-channel-row ${expanded ? "cm-channel-row--expanded" : ""}`}>
                  <button type="button" className="cm-channel-row-main"
                    onClick={() => toggleExpand(ch)} aria-expanded={expanded} title="点击展开 / 收起编辑">
                    <span className={`cm-channel-dot ${isActive ? "cm-channel-dot--on" : ""} ${hasKey ? "cm-channel-dot--keyed" : ""}`} />
                    <span className="cm-channel-name">{ch.name}</span>
                    {host && <span className="cm-channel-url">{host}</span>}
                    {hasModels && <span className="cm-channel-meta">{modelCount} 个模型</span>}
                    {isActive && <span className="cm-channel-badge">当前使用</span>}
                    <span className="cm-channel-caret">{expanded ? "▾" : "▸"}</span>
                  </button>
                  <div className="cm-channel-row-actions">
                    {!fixedSingle && !isActive && (
                      <button type="button" className="cm-channel-action-btn"
                        onClick={() => switchActive(ch.id)} title="设为默认渠道">设为默认</button>
                    )}
                    {!fixedSingle && (
                      <button type="button" className="cm-channel-action-btn cm-channel-action-btn--danger"
                        title="删除该渠道"
                        onClick={async () => {
                          try {
                            const empty = await checkChannelPendingTasks(channelType);
                            if (empty) {
                              setDeleteTarget(ch.id);
                            } else {
                              toast("该渠道类型存在未完成的任务，暂时无法删除", "error");
                            }
                          } catch {
                            toast("队列状态查询失败，请稍后重试", "error");
                          }
                        }}>删除</button>
                    )}
                  </div>
                </div>

                {expanded && (
                  <div className="cm-row-panel">
                    {renderEditorBody()}
                    {renderEditorFooter("edit")}
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* 新增渠道面板（行内展开） */}
        {!fixedSingle && expandedId === "__new__" ? (
          <div className="cm-row-panel cm-row-panel--new">
            <div className="cm-row-panel-title">新增渠道</div>
            {renderEditorBody()}
            {renderEditorFooter("add")}
          </div>
        ) : (
          !fixedSingle && expandedId !== "__new__" && (
            <button type="button" className="cm-add-footer" onClick={openAdd}>
              + 新增渠道
            </button>
          )
        )}
      </div>

      {/* 删除确认 */}
      {deleteTarget && (
        <div className="modal-backdrop delete-batch-backdrop" role="dialog" aria-modal="true" onClick={() => setDeleteTarget(null)}>
          <div className="modal-panel clip-delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="delete-confirm-title">删除渠道</h2>
              <button type="button" className="icon-button modal-close-button" aria-label="关闭" onClick={() => setDeleteTarget(null)}>×</button>
            </div>
            <p className="clip-delete-modal-text">
              确认删除渠道 <strong>「{channels.find((c: T) => c.id === deleteTarget)?.name ?? ""}」</strong>？此操作不可撤销。
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
