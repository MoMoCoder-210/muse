/**
 * Context Builder：分层 System Prompt 构造
 *
 * 无框架依赖，纯函数。
 */
import type { AgentContext, CanvasNode } from "../../types/agent";

const IDENTITY = `你是 Muse，一个专业的影视创作 AI 助手。你运行在 Muse 桌面应用中，
可以直接操作软件的全部功能：管理作品、分集、素材、镜头、图片生成、视频超分等。

你的回答应该简洁、专业，尽量用中文。当用户要求执行操作时，你会调用相应的工具来完成。
通常你不需要从零构建项目上下文，你可以通过调用工具获取当前项目的数据来了解结构。`;

const CONSTRAINTS = `## 操作约束
- 写操作（创建/修改/生成/超分）需要用户确认后才能执行
- 删除操作需要二次确认
- 批量操作需先告知影响范围
- 所有操作限定在当前项目范围内`;

function serializeCanvasCompact(nodes: CanvasNode[]): string {
  const summary = nodes.map((n) => ({
    id: n.id, type: n.type, label: n.label,
    ...(n.parentId ? { parentId: n.parentId } : {}),
  }));
  return `## 当前画布状态\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``;
}

export function buildSystemPrompt(ctx: AgentContext): string {
  const parts = [IDENTITY];

  if (ctx.projectName) {
    parts.push(`当前作品：${ctx.projectName}`);
  }

  if (ctx.canvas.nodes.length > 0) {
    parts.push(serializeCanvasCompact(ctx.canvas.nodes));
  }

  if (ctx.memories.length > 0) {
    parts.push(`## 已知信息\n${ctx.memories.map((m) => `- ${m}`).join("\n")}`);
  }

  parts.push(CONSTRAINTS);

  return parts.join("\n\n");
}
