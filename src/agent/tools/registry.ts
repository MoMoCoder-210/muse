/**
 * Tool Registry：集中管理全部 Tool 定义
 *
 * Registry 保存完整 Tool（含 Zod Schema、权限、执行函数），
 * 每轮仅将 visibleTools 注入模型上下文，绝不将全量 Registry 注入 Prompt。
 */
import type { ToolCandidate, ToolSchema, ToolResult, ToolPermission, ToolCategory } from "../../types/agent";
import { categoryPermission } from "../domain/policy";
import { z } from "zod";

// ── 内部 Tool 定义结构 ──────────────────────────────

export interface ToolDef<Params = Record<string, unknown>> {
  name: string;
  description: string;
  category: ToolCategory;
  permission: ToolPermission;
  target: string;
  schema: z.ZodType<Params>;
  execute: (params: Params) => Promise<ToolResult>;
}

// ── Registry ─────────────────────────────────────────

const registry = new Map<string, ToolDef>();

export function registerTool(def: ToolDef): void {
  registry.set(def.name, def);
}

export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

/** 生成候选概要列表（两阶段 Tool Search 第一阶段） */
export function buildCandidates(): ToolCandidate[] {
  const result: ToolCandidate[] = [];
  for (const [name, def] of registry) {
    result.push({
      name,
      description: def.description,
      category: def.category,
      permission: def.permission,
      target: def.target,
    });
  }
  return result;
}

/** 加载指定 Tool 的完整 Schema（第二阶段） */
export function loadSchema(name: string): ToolSchema | null {
  const def = registry.get(name);
  if (!def) return null;
  return {
    name: def.name,
    description: def.description,
    parameters: zodToJsonSchema(def.schema),
    permission: def.permission,
  };
}

/**
 * 将 Zod schema 转为 JSON Schema 纯对象。
 *
 * 当前为手写简化版，仅支持 ZodObject(ZodString|ZodNumber|ZodEnum)，
 * 空对象 schema 直接返回 type:object。
 * 后续复杂 Schema 引入 zod-to-json-schema 替换。
 */
function zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  try {
    const shape = (schema as { _def?: { shape?: () => Record<string, z.ZodType<unknown>> } })._def?.shape;
    if (!shape) return { type: "object", properties: {} };
    const shapeObj = shape();
    const properties: Record<string, unknown> = {};
    for (const [key, zodType] of Object.entries(shapeObj)) {
      const typeName = (zodType as { _def?: { typeName?: string; values?: string[] } })._def?.typeName;
      if (typeName === "ZodEnum") {
        properties[key] = { type: "string", enum: (zodType as { _def?: { values?: string[] } })._def?.values };
      } else if (typeName === "ZodNumber") {
        properties[key] = { type: "number" };
      } else {
        properties[key] = { type: "string" };
      }
    }
    return { type: "object", properties, required: Object.keys(shapeObj) };
  } catch {
    return { type: "object", properties: {} };
  }
}

// ── 工具注册辅助 ─────────────────────────────────────

export function defineTool<Params extends Record<string, unknown>>(opts: {
  name: string;
  description: string;
  category: ToolCategory;
  target: string;
  schema: z.ZodType<Params>;
  execute: (params: Params) => Promise<ToolResult>;
}): ToolDef<Params> {
  return {
    ...opts,
    permission: categoryPermission(opts.category),
  };
}
