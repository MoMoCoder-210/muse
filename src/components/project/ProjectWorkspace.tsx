import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo } from "../../types/project";
import { getProject, getScriptSource, getClipScripts } from "../../services/tauri";
import { WorkflowBoard } from "./WorkflowBoard";
import { ScriptImportPanel } from "./ScriptImportPanel";
import { ClipListPanel } from "./ClipListPanel";
import type { ClipScriptInfo } from "../../types/project";

type ProjectWorkspaceProps = {
  project: ProjectInfo | null;
  onProjectUpdated: (project: ProjectInfo) => void;
};

export function ProjectWorkspace({ project, onProjectUpdated }: ProjectWorkspaceProps) {
  const [clipScripts, setClipScripts] = useState<ClipScriptInfo[] | null>(null);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    getClipScripts(project.id).then((cs) => {
      if (!cancelled) setClipScripts(cs);
    }).catch(() => {
      if (!cancelled) setClipScripts([]);
    });
    return () => { cancelled = true; };
  }, [project?.id]);

  // 拆解进行中时轮询
  useEffect(() => {
    if (!project || !clipScripts) return;
    const hasRunning = clipScripts.some((cs) => cs.status === "pending" || cs.status === "running");
    if (!hasRunning) return;
    const timer = setInterval(() => {
      getClipScripts(project.id).then(setClipScripts).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [project?.id, clipScripts]);

  // 计算禁用步骤：没有拆解成功的片段时，步骤2（资产管理，索引1）及以上全部禁用
  let disabledSteps: Set<number> | null = null;
  if (clipScripts !== null) {
    const anyDisassembled = clipScripts.some((cs) => cs.status === "success");
    disabledSteps = new Set<number>();
    if (!anyDisassembled) {
      for (let i = 1; i <= 4; i++) disabledSteps.add(i);
    }
  }

  if (!project) {
    return (
      <div className="empty-workspace">
        <h2>选择一个项目开始工作</h2>
        <p>左侧选择项目后，这里会显示项目工作区、片段、分镜和任务流程。</p>
      </div>
    );
  }

  // 顶部为工作流阶段板，下方为当前阶段工作区
  return (
    <div className="workspace-inner">
      <WorkflowBoard currentStep={project.current_step} disabledSteps={disabledSteps} />
      <WorkspaceContent project={project} onProjectUpdated={onProjectUpdated} />
    </div>
  );
}

/**
 * 工作区内容路由。
 *
 * 视图切换依据是「是否存在剧本源」而非 projects.current_step：
 *   - 无剧本源 → 显示剧本导入面板
 *   - 有剧本源 → 显示片段列表（即便拆分还在进行中也显示，列表内部展示拆分状态并轮询）
 *
 * 这样修复了「导入后 current_step 仍是 project，UI 卡在导入面板、看不到拆分进度」的 bug。
 *
 * @author yt @date 20260702 改为按 scriptSource 是否存在驱动视图切换
 */
function WorkspaceContent({
  project,
  onProjectUpdated,
}: {
  project: ProjectInfo;
  onProjectUpdated: (p: ProjectInfo) => void;
}) {
  // hasScript: null=检测中, true=有剧本源, false=无剧本源
  const [hasScript, setHasScript] = useState<boolean | null>(null);

  const checkScript = useCallback(async () => {
    try {
      const src = await getScriptSource(project.id);
      setHasScript(src !== null);
    } catch {
      // 拉取失败保守视为无剧本，让用户能走导入流程
      setHasScript(false);
    }
  }, [project.id]);

  useEffect(() => {
    checkScript();
  }, [checkScript]);

  // 拆分进行中时轮询 project 让步骤板和状态实时更新
  // @author yt @date 20260702 修复拆分状态不实时展示、切项目回来状态丢失
  const isSplitting = project.current_step === "project" || project.current_step === "split";
  useEffect(() => {
    if (!hasScript || !isSplitting) return;
    const timer = window.setInterval(async () => {
      try {
        const updated = await getProject(project.id);
        onProjectUpdated(updated);
      } catch {
        // 轮询失败忽略，下个 tick 重试
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [hasScript, isSplitting, project.id, onProjectUpdated]);

  const handleImported = useCallback(async () => {
    // 导入成功后：重新拉剧本源存在性 → 切到片段视图；并刷新 project
    await checkScript();
    try {
      const updated = await getProject(project.id);
      onProjectUpdated(updated);
    } catch {
      // 刷新失败不影响视图切换
    }
  }, [checkScript, project.id, onProjectUpdated]);

  if (hasScript === null) {
    return (
      <div className="clip-list-panel">
        <div className="panel-loading">加载中…</div>
      </div>
    );
  }

  // 无剧本源：显示导入入口（含粘贴/文件两种方式）
  if (!hasScript) {
    return <ScriptImportPanel project={project} onImported={handleImported} />;
  }

  // 有剧本源：显示片段列表（列表内部展示拆分状态并轮询）
  return <ClipListPanel project={project} />;
}
