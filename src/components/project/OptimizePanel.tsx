import { useState, useCallback, useEffect, useRef } from "react";
import {
  optimizeScript,
  pollTaskResult,
  listOptimizations,
  selectOptimization,
  deleteOptimization,
  updateOptimizationText,
  onOptimizeStream,
  updateClip,
  type OptimizationRecord,
} from "../../services/tauri";
import { useToast } from "../../hooks/useToast";

// ─── 类型 ──────────────────────────────────────────────

type Mode = "polish" | "expand" | "condense";

const MODE_OPTIONS: Array<{ value: Mode; label: string; desc: string }> = [
  { value: "polish", label: "润色", desc: "修正语病、统一文风" },
  { value: "expand", label: "扩写", desc: "补充神态、环境、心理细节" },
  { value: "condense", label: "精简", desc: "删除冗余，保留核心剧情与台词" },
];

const MODE_LABEL: Record<Mode, string> = {
  polish: "润色",
  expand: "扩写",
  condense: "精简",
};

const SAVE_DEBOUNCE_MS = 600;

const FRIENDLY_ERROR = "操作失败，请检查模型配置！";

// ─── 组件 Props ────────────────────────────────────────

interface OptimizePanelProps {
  projectId: string;
  clipId: string;
  sourceText: string;
  clipTitle: string;
  onClose: () => void;
  onChange?: () => void;
}

// ─── 组件 ──────────────────────────────────────────────

export function OptimizePanel({
  projectId,
  clipId,
  sourceText,
  clipTitle,
  onClose,
  onChange,
}: OptimizePanelProps) {
  const [mode, setMode] = useState<Mode>("polish");
  const [instruction, setInstruction] = useState("");
  const [versions, setVersions] = useState<OptimizationRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("source");
  const [editingText, setEditingText] = useState(sourceText);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const { toast } = useToast();
  const taskIdRef = useRef<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const skipSyncRef = useRef(false);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const [showScrollLeft, setShowScrollLeft] = useState(false);
  const [showScrollRight, setShowScrollRight] = useState(false);
  const smoothScrollRef = useRef<((delta: number) => void) | null>(null);

  // ── Tab 栏溢出检测 ────────────────────────

  const scrollIndicatorsRef = useRef({ left: false, right: false });

  const updateScrollIndicators = useCallback(() => {
    const el = tabbarRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    const prev = scrollIndicatorsRef.current;
    if (prev.left !== left) { prev.left = left; setShowScrollLeft(left); }
    if (prev.right !== right) { prev.right = right; setShowScrollRight(right); }
  }, []);

  // 滚动引擎（与 versions 解耦，不重建）
  useEffect(() => {
    const el = tabbarRef.current;
    if (!el) return;

    let scrollTarget = el.scrollLeft;
    let rafId = 0;
    const step = () => {
      const diff = scrollTarget - el.scrollLeft;
      if (Math.abs(diff) < 0.5) {
        el.scrollLeft = scrollTarget;
        rafId = 0;
        return;
      }
      el.scrollLeft += diff * 0.3;
      rafId = requestAnimationFrame(step);
    };
    const smoothScroll = (delta: number) => {
      const max = el.scrollWidth - el.clientWidth;
      scrollTarget = Math.max(0, Math.min(max, scrollTarget + delta));
      if (!rafId) rafId = requestAnimationFrame(step);
    };
    smoothScrollRef.current = smoothScroll;

    // 鼠标滚轮：纵向滚轮转为横向平滑滚动
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        smoothScroll(e.deltaY > 0 ? Math.max(e.deltaY, 40) : Math.min(e.deltaY, -40));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("wheel", onWheel);
      smoothScrollRef.current = null;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []); // 不依赖 versions，滚动引擎只初始化一次

  // 溢出检测（独立 effect，versions 变化时只更新指示器）
  useEffect(() => {
    updateScrollIndicators();
    const el = tabbarRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateScrollIndicators, { passive: true });
    const ro = new ResizeObserver(updateScrollIndicators);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateScrollIndicators);
      ro.disconnect();
    };
  }, [updateScrollIndicators, versions]);

  // ── 流式区自动滚底 ──────────────────────────

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [streamText]);

  // ── 加载版本列表 ──────────────────────────────

  const loadVersions = useCallback(async () => {
    try {
      const res = await listOptimizations(clipId);
      setVersions(res.items);
      setActiveId(res.active_id);
      setActiveTab((prev) => {
        if (prev === "source") return "source";
        if (res.items.some((v) => v.id === prev)) return prev;
        return "source";
      });
    } catch {
      /* 忽略 */
    }
  }, [clipId]);

  // ── 挂载：加载 + 流式监听 ──────────────────────

  useEffect(() => {
    loadVersions();
    const unlisten = onOptimizeStream((taskId, chunk) => {
      if (taskIdRef.current && taskId === taskIdRef.current) {
        setStreamText((prev) => prev + chunk);
      }
    });
    return () => {
      unlisten();
      if (pollRef.current) clearInterval(pollRef.current);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [loadVersions]);

  // ── Tab 切换或版本更新时同步编辑文本 ────────────

  useEffect(() => {
    // 正在流式时不覆盖（流式区内显示 streamText，非编辑框）
    if (streaming) return;
    // 应用版本后跳过一次同步（避免旧 sourceText prop 覆盖新文本）
    if (skipSyncRef.current) { skipSyncRef.current = false; return; }
    if (activeTab === "source") {
      setEditingText(sourceText);
    } else {
      const v = versions.find((x) => x.id === activeTab);
      if (v) setEditingText(v.optimized_text);
    }
  }, [activeTab, versions, sourceText, streaming]);

  // ── 防抖保存 ──────────────────────────────────

  const flushSave = useCallback(
    (text: string, tab: "source" | string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(async () => {
        saveTimerRef.current = null;
        try {
          if (tab === "source") {
            await updateClip({ clip_id: clipId, source_text: text });
            onChange?.();
          } else {
            await updateOptimizationText(tab, text);
            setVersions((prev) =>
              prev.map((v) =>
                v.id === tab
                  ? { ...v, optimized_text: text, char_count_after: text.length }
                  : v,
              ),
            );
          }
        } catch {
          /* 下次编辑会重试 */
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [clipId, onChange],
  );

  const handleTextChange = useCallback(
    (text: string) => {
      setEditingText(text);
      if (!streaming) flushSave(text, activeTab);
    },
    [activeTab, streaming, flushSave],
  );

  // ── 发起一次优化 ──────────────────────────────

  const handleStart = useCallback(async () => {
    setStreaming(true);
    setStreamText("");
    try {
      const result = await optimizeScript({
        projectId,
        clipId,
        text: sourceText,
        mode,
        instruction: instruction.trim() || undefined,
      });
      taskIdRef.current = result.taskId;

      // 立即加载版本列表（含新 running 记录），并切换到新 Tab
      await loadVersions();
      setActiveTab(result.optimizationId);

      pollRef.current = window.setInterval(async () => {
        try {
          const r = await pollTaskResult(result.taskId);
          if (r.status === "success") {
            if (pollRef.current) clearInterval(pollRef.current);
            taskIdRef.current = null;
            setStreaming(false);
            await loadVersions();
          } else if (r.status === "failed") {
            if (pollRef.current) clearInterval(pollRef.current);
            taskIdRef.current = null;
            setStreaming(false);
            await loadVersions(); // 刷新状态（running → failed）
            toast(FRIENDLY_ERROR, "error");
          }
        } catch {
          /* 轮询失败静默重试 */
        }
      }, 800);
    } catch {
      setStreaming(false);
      toast(FRIENDLY_ERROR, "error");
    }
  }, [projectId, clipId, sourceText, mode, instruction, toast, loadVersions]);

  // ── 应用版本：替换原文 ────────────────────────

  const handleSelect = useCallback(
    async (v: OptimizationRecord) => {
      try {
        await updateClip({ clip_id: clipId, source_text: v.optimized_text });
        await selectOptimization(clipId, v.id);
        setActiveId(v.id);
        skipSyncRef.current = true;
        setActiveTab("source");
        setEditingText(v.optimized_text);
        toast("已应用到原文", "success");
        onChange?.();
      } catch {
        toast(FRIENDLY_ERROR, "error");
      }
    },
    [clipId, onChange, toast],
  );

  // ── 删除版本 ──────────────────────────────────

  const handleDelete = useCallback(
    async (v: OptimizationRecord) => {
      try {
        await deleteOptimization(v.id);
        setVersions((prev) => prev.filter((x) => x.id !== v.id));
        if (activeId === v.id) setActiveId(null);
        if (activeTab === v.id) setActiveTab("source");
        onChange?.();
      } catch {
        toast(FRIENDLY_ERROR, "error");
      }
    },
    [activeId, activeTab, onChange, toast],
  );

  // ── 渲染 ──────────────────────────────────────

  const activeVersion =
    activeTab !== "source" ? versions.find((v) => v.id === activeTab) ?? null : null;

  return (
    <div className="op-overlay" onClick={onClose}>
      <div className="op-panel" onClick={(e) => e.stopPropagation()}>
        {/* ── 头部 ── */}
        <div className="op-header">
          <div className="op-header-titles">
            <h3 className="op-title">剧本优化</h3>
            <span className="op-subtitle">{clipTitle}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* ── Tab 栏 ── */}
        <div className="op-tabbar-wrap">
          {showScrollLeft && (
            <div className="op-tabbar-fade op-tabbar-fade--left" onClick={() => smoothScrollRef.current?.(-150)}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </div>
          )}
          <div className="op-tabbar" ref={tabbarRef}>
            <button
              type="button"
              className={`op-tabbar-item ${activeTab === "source" ? "is-active" : ""}`}
              onClick={() => setActiveTab("source")}
            >
              原文
            </button>
            {versions.map((v) => {
              const isActive = v.id === activeId;
              const isSelected = v.id === activeTab;
              const isRunning = v.status === "running";
              return (
                <button
                  key={v.id}
                  type="button"
                  className={`op-tabbar-item ${isSelected ? "is-active" : ""}`}
                  onClick={() => setActiveTab(v.id)}
                >
                  <span className="op-tabbar-label">
                    {isRunning ? (
                      <span className="spinner spinner--sm" />
                    ) : null}
                    {MODE_LABEL[v.mode as Mode]}
                    {isRunning && (
                      <span className="op-tabbar-time">&nbsp;生成中</span>
                    )}
                  </span>
                  {isActive && <span className="op-tabbar-dot" />}
                </button>
              );
            })}
          </div>
          {showScrollRight && (
            <div className="op-tabbar-fade op-tabbar-fade--right" onClick={() => smoothScrollRef.current?.(150)}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          )}
        </div>

        {/* ── 内容区 ── */}
        <div className="op-body">
          {/* 信息栏：模式 + 字数 | 操作按钮居右 */}
          <div className="op-info">
            <span className="op-info-title">
              {activeVersion ? MODE_LABEL[activeVersion.mode as Mode] : "原文"}
              {!streaming && <>&nbsp;·&nbsp;{editingText.length} 字</>}
            </span>
            <div className="op-info-right">
              {activeVersion?.status === "running" && (
                <span className="op-tag op-tag--running">生成中…</span>
              )}
              {activeVersion && activeVersion.status !== "running" && (
                <div className="op-info-actions">
                  {activeVersion.id === activeId ? (
                    <span className="op-tag op-tag--active">当前版本</span>
                  ) : (
                    <button type="button" className="op-pill op-pill--accent" onClick={() => handleSelect(activeVersion)}>
                      使用此版本
                    </button>
                  )}
                  {activeVersion.id !== activeId && (
                    <button type="button" className="op-pill op-pill--danger" onClick={() => handleDelete(activeVersion)}>
                      删除
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 编辑区 / 流式区 */}
          {streaming ? (
            <div className="op-stream">
              <div className="op-stream-text" ref={streamRef}>
                {streamText}
                <span className="op-caret" />
              </div>
              <p className="op-stream-note">生成完成后可编辑优化记录</p>
            </div>
          ) : (
            <textarea
              className="op-editor"
              value={editingText}
              onChange={(e) => handleTextChange(e.target.value)}
              placeholder={
                activeTab === "source"
                  ? "输入或粘贴分集剧本…"
                  : "优化结果，可在此编辑…"
              }
            />
          )}
        </div>

        {/* ── 底部操作栏 ── */}
        <div className="op-footer">
          <div className="op-footer-instruction-row">
            <input
              className="op-footer-instruction"
              type="text"
              placeholder="补充指令，例如：把主角的语气改温柔一点"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={streaming}
            />
          </div>
          <div className="op-footer-actions">
            <div className="op-segmented" role="tablist">
              {MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="tab"
                  aria-selected={mode === opt.value}
                  className={`op-seg ${mode === opt.value ? "op-seg--active" : ""}`}
                  onClick={() => setMode(opt.value)}
                  disabled={streaming}
                  title={opt.desc}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {streaming ? (
              <button type="button" className="op-btn op-btn--primary" disabled>
                <span className="spinner" />
                优化中…
              </button>
            ) : (
              <button type="button" className="op-btn op-btn--primary" onClick={handleStart}>
                开始优化
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
