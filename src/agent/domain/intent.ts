/**
 * 用户意图分类（纯函数，无外部依赖）
 *
 * 用于 Tool Search 第一阶段：根据意图过滤候选工具。
 */
import type { ToolCategory } from "../../types/agent";

const INTENT_KEYWORDS: Record<string, ToolCategory[]> = {
  "列出|查看|显示|有哪些|所有|列表|查询|详情|状态|检查": ["查询"],
  "创建|新建|添加|生成|导入|注册": ["创建", "修改"],
  "修改|更新|改|编辑|设置|切换|选中|绑定": ["修改"],
  "删除|移除|取消|清空|放弃": ["删除"],
  "超分|放大|增强|upscale|队列|任务": ["创建", "修改"],
  "开始|启动|停止|重启|管理|配置": ["管理"],
  "作品|项目|project": ["查询", "创建", "删除"],
  "分集|clip|集|章节": ["查询", "创建", "修改", "删除"],
  "素材|人物|场景|道具|asset|角色": ["查询", "创建", "修改", "删除"],
  "镜头|storyboard|shot|画面": ["查询", "创建", "修改", "删除"],
  "图片|image|生图": ["创建", "查询"],
  "视频|video|导出|拼接|concat": ["创建", "修改"],
  "语音|声音|音频|voice|tts": ["创建", "查询"],
};

export function classifyIntent(text: string): ToolCategory[] {
  const result = new Set<ToolCategory>();
  for (const [pattern, categories] of Object.entries(INTENT_KEYWORDS)) {
    if (new RegExp(pattern, "i").test(text)) {
      categories.forEach((c) => result.add(c));
    }
  }
  // 默认返回查询类
  return result.size > 0 ? [...result] : ["查询"];
}
