/**
 * 两阶段 Tool Search
 *
 * Phase 1: 根据领域/意图/画布过滤候选概要（上限 8）
 * Phase 2: 从候选中选择 1-2 个加载完整 Schema
 */
import type { ToolCandidate, ToolSchema, ToolCategory } from "../../types/agent";
import { buildCandidates, loadSchema } from "./registry";
import { classifyIntent } from "../domain/intent";
import { TOOL_CANDIDATE_LIMIT, TOOL_SCHEMA_LIMIT, TOOL_CONTEXT_BUDGET } from "../domain/types";

export interface SearchContext {
  text: string;
}

export interface SearchResult {
  candidates: ToolCandidate[];
  schemas: ToolSchema[];
}

/** 第一阶段：候选检索 */
export function searchCandidates(ctx: SearchContext): ToolCandidate[] {
  const all = buildCandidates();
  if (all.length === 0) return [];

  const intents = classifyIntent(ctx.text);

  // 按意图过滤
  let filtered = all.filter((c) => intents.some((intent) => c.category === intent));

  // 如果过滤后太多或太少，用项目上下文微调
  if (filtered.length === 0) {
    filtered = all.filter((c) => c.category === "查询");
  }

  // 得分排序：意图匹配 + 查询类优先
  const scored = filtered.map((c) => ({
    candidate: c,
    score: (c.category === "查询" ? 2 : 1),
  }));
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, TOOL_CANDIDATE_LIMIT).map((s) => s.candidate);
}

/** 第二阶段：精确加载 Schema */
export function loadSchemas(candidates: ToolCandidate[], selectedNames?: string[]): ToolSchema[] {
  const names = selectedNames ?? candidates.slice(0, TOOL_SCHEMA_LIMIT).map((c) => c.name);
  const schemas: ToolSchema[] = [];
  for (const name of names) {
    const schema = loadSchema(name);
    if (schema) schemas.push(schema);
  }
  return schemas;
}

/** 完整搜索流程：返回可见工具 Schema 列表 */
export function visibleTools(ctx: SearchContext): ToolSchema[] {
  const candidates = searchCandidates(ctx);
  return loadSchemas(candidates);
}

/** 估算 Tool Schema 序列化后占用的 Token 数 */
export function estimateTokens(schemas: ToolSchema[]): number {
  return schemas.reduce((sum, s) => sum + JSON.stringify(s).length / 4, 0);
}

/** 判断是否超出上下文预算 */
export function exceedsBudget(schemas: ToolSchema[]): boolean {
  return estimateTokens(schemas) > TOOL_CONTEXT_BUDGET;
}

export { TOOL_CANDIDATE_LIMIT, TOOL_SCHEMA_LIMIT, TOOL_CONTEXT_BUDGET };
