/**
 * 查询类工具（Phase 1 首批 10 个）
 *
 * 每个 Tool 通过 registerTool() 自注册到全局 Registry。
 * 组件通过 tools/*.ts 导入触发副作用注册。
 */
import { z } from "zod";
import { defineTool, registerTool } from "./registry";
import * as tauri from "../../services/tauri";

// ── 项目查询 ─────────────────────────────────────────

registerTool(
  defineTool({
    name: "list_projects",
    description: "列出所有作品。不需要参数，返回作品 ID、名称、工作区路径和创建时间。",
    category: "查询",
    target: "project",
    schema: z.object({}),
    execute: async () => {
      const projects = await tauri.listProjects();
      return { success: true, data: projects };
    },
  })
);

registerTool(
  defineTool({
    name: "get_project",
    description: "获取单个作品的详情，包括名称、工作区路径、风格、当前步骤。",
    category: "查询",
    target: "project",
    schema: z.object({ projectId: z.string() }),
    execute: async ({ projectId }) => {
      const project = await tauri.getProject(projectId);
      return { success: true, data: project };
    },
  })
);

// ── 分集查询 ─────────────────────────────────────────

registerTool(
  defineTool({
    name: "list_clips",
    description: "列出指定作品下的所有分集，返回分集 ID、标题、状态和当前步骤。",
    category: "查询",
    target: "clip",
    schema: z.object({ projectId: z.string() }),
    execute: async ({ projectId }) => {
      const clips = await tauri.listClips(projectId);
      return { success: true, data: clips };
    },
  })
);

// ── 素材查询 ─────────────────────────────────────────

registerTool(
  defineTool({
    name: "list_clip_assets",
    description: "列出分集下所有素材（人物/场景/道具），含绑定图片路径、描述和提示词。",
    category: "查询",
    target: "asset",
    schema: z.object({ clipId: z.string() }),
    execute: async ({ clipId }) => {
      const assets = await tauri.listClipAssets(clipId);
      return { success: true, data: assets };
    },
  })
);

registerTool(
  defineTool({
    name: "list_asset_images",
    description: "获取素材的所有已生成图片列表，含是否选定状态。需要 clip_id、asset_type(character|scene|item) 和素材 name。",
    category: "查询",
    target: "asset",
    schema: z.object({
      clipId: z.string(),
      assetType: z.enum(["character", "scene", "item"]),
      name: z.string(),
    }),
    execute: async ({ clipId, assetType, name }) => {
      const images = await tauri.listAssetImages({
        clip_id: clipId,
        asset_type: assetType,
        name,
      });
      return { success: true, data: images };
    },
  })
);

registerTool(
  defineTool({
    name: "list_asset_image_tasks",
    description: "查询素材的全部图片和任务（含 pending/running/failed 状态），用于查看生成进度。",
    category: "查询",
    target: "asset",
    schema: z.object({
      clipId: z.string(),
      assetType: z.enum(["character", "scene", "item"]),
      name: z.string(),
    }),
    execute: async ({ clipId, assetType, name }) => {
      const tasks = await tauri.listAssetImageTasks({
        clip_id: clipId,
        asset_type: assetType,
        name,
      });
      return { success: true, data: tasks };
    },
  })
);

// ── 镜头查询 ─────────────────────────────────────────

registerTool(
  defineTool({
    name: "list_storyboards",
    description: "列出分集下所有镜头的详情，含序号、提示词、关联素材、时长。",
    category: "查询",
    target: "storyboard",
    schema: z.object({ clipId: z.string() }),
    execute: async ({ clipId }) => {
      const storyboards = await tauri.listStoryboards(clipId);
      return { success: true, data: storyboards };
    },
  })
);

registerTool(
  defineTool({
    name: "list_storyboard_videos",
    description: "查询镜头的所有已生成视频，含文件路径、时长、来源。",
    category: "查询",
    target: "storyboard",
    schema: z.object({ storyboardId: z.string() }),
    execute: async ({ storyboardId }) => {
      const videos = await tauri.listStoryboardVideos(storyboardId);
      return { success: true, data: videos };
    },
  })
);

// ── 超分查询 ─────────────────────────────────────────

registerTool(
  defineTool({
    name: "list_upscale_jobs",
    description: "查询全部超分任务的状态和进度，含模型、倍率、百分比、错误信息。",
    category: "查询",
    target: "system",
    schema: z.object({}),
    execute: async () => {
      const jobs = await tauri.listUpscaleJobs();
      return { success: true, data: jobs };
    },
  })
);

// ── 设置查询 ─────────────────────────────────────────

registerTool(
  defineTool({
    name: "get_settings",
    description: "获取当前应用设置（AI 渠道配置、作品目录等）。不需要参数。",
    category: "查询",
    target: "system",
    schema: z.object({}),
    execute: async () => {
      const settings = await tauri.getSettings();
      return { success: true, data: settings };
    },
  })
);
