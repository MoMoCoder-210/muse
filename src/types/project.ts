export type ProjectInfo = {
  id: string;
  name: string;
  description: string;
  workspace_path: string;
  status: string;
  current_step: string;
  style_mode: string;
  created_at: string;
};

export type CreateProjectInput = {
  name: string;
  description?: string;
  workspace_path: string;
  input_mode?: string;
  style_mode?: string;
};

export type ScriptSource = {
  id: string;
  project_id: string;
  source_type: "paste" | "txt";
  file_name: string | null;
  /** 修正类型与实际返回不一致的问题 */
  raw_content?: string;
  normalized_content?: string;
  split_status: "pending" | "running" | "success" | "failed";
  error_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
};

/** 剧本源列表项（不含原文内容，仅元数据） */
export type ScriptSourceListItem = {
  id: string;
  project_id: string;
  source_type: "paste" | "txt";
  file_name: string | null;
  split_status: "pending" | "running" | "success" | "failed";
  error_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
};

export type ClipStatus =
  | "pending"
  | "running"
  | "script_ready"
  | "asset_ready"
  | "storyboard_ready"
  | "media_ready"
  | "done"
  | "failed";

export type Clip = {
  id: string;
  project_id: string;
  source_id: string | null;
  sort_index: number;
  title: string;
  summary: string;
  source_text: string;
  estimated_duration: number | null;
  status: ClipStatus;
  current_step: string;
  created_at: string;
  updated_at: string;
};

export type ImportScriptInput = {
  project_id: string;
  source_type: "paste" | "txt";
  content?: string;
  file_path?: string;
};

export type ImportScriptResult = {
  source_id: string;
};

/** 新增分集级写操作类型 */

/** 批量删除分集（软删除） */
export type DeleteClipsInput = {
  clip_ids: string[];
};

/** 更新分集，三个内容字段均可选，传哪个改哪个 */
export type UpdateClipInput = {
  clip_id: string;
  title?: string;
  summary?: string;
  source_text?: string;
};

/** 在原 source_text 的第 split_position 个字符处拆成两段 */
export type SplitClipInput = {
  clip_id: string;
  split_position: number;
};

export type SplitClipResult = {
  first_clip_id: string;
  second_clip_id: string;
};

/** 拆解类型 */

export type AssetType = "character" | "scene" | "item";

/** 人物绑定的声音（公共音色或本地上传） */
export type VoiceBinding =
  | { source: "public"; voiceId: string; label: string; arkFileId?: string }
  | { source: "local"; filePath: string; label: string; arkFileId?: string };

export type AssetResource = {
  type: AssetType;
  name: string;
  description: string;
  prompt: string;
  tags?: string[];
  /** 人物素材可绑定声音（公共音色 / 本地上传），场景与道具无此字段 */
  voiceBinding?: VoiceBinding;
};

export type ParsedAssets = {
  characters: AssetResource[];
  scenes: AssetResource[];
  items: AssetResource[];
};

export type ClipScriptInfo = {
  id: string;
  clip_id: string;
  script_summary: string;
  extracted_resources_json: string;
  status: "pending" | "running" | "success" | "failed";
};

export type GenerateClipScriptInput = {
  clip_id: string;
};

/** 镜头状态 */
export type StoryboardState = "pending" | "running" | "ready" | "failed" | "invalidated";

/** 镜头数据（对应 storyboards 表） */
export type StoryboardMention = {
  /** 稳定的本镜头图片编号 N */
  n: number;
  assetId: string;
  name: string;
  type: AssetType | string;
  /** 当前选定图片的本地路径；仅供前端预览，视频任务使用 ark_file_id */
  imagePath?: string | null;
  /** 完整、可精确匹配的标记：素材名(@图片N) */
  assetTag: string;
};

export type PromptDocNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PromptDocNode[];
};

export type PromptDoc = PromptDocNode;

/** video_param_json 在前端的扩展结构；模型参数与编辑模型共存。 */
export type StoryboardVideoParams = {
  model?: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  mention_map?: StoryboardMention[];
  prompt_doc?: PromptDoc;
};

export type Storyboard = {
  id: string;
  project_id: string;
  clip_id: string;
  sbid: string;
  seq_num: number;
  source_text: string;
  summary: string;
  dialogue: string;
  visual_description: string;
  video_prompt: string;
  /** JSON 数组字符串 — 关联人物素材 ID */
  character_ids_json: string;
  /** JSON 数组字符串 — 关联场景素材 ID */
  scene_ids_json: string;
  /** JSON 数组字符串 — 关联道具素材 ID */
  item_ids_json: string;
  image_param_json: string | null;
  video_param_json: string | null;
  voice_param_json: string | null;
  image_state: StoryboardState;
  voice_state: StoryboardState;
  video_state: StoryboardState;
  voice_path: string | null;
  voice_duration: number | null;
  /** 镜头时长（秒），由模型拆解或手动调整写回 */
  video_duration: number | null;
  /** 当前选中的 storyboard_videos.id */
  selected_video_id: string | null;
};

/** 镜头关联的素材简要信息（含绑定图片路径） */
export type StoryboardAssetInfo = {
  asset_id: string;
  type: AssetType;
  name: string;
  description: string;
  prompt: string;
  /** 素材选定的图片路径（可能为 null） */
  selected_image_path: string | null;
  /** 指定 storyboard 查询时由后端按该镜头 mention_map 注入；未引用为 null。 */
  index?: number | null;
  /** 完整引用文本：素材名(@图片N)，用于精确匹配为一个胶囊。 */
  assetTag?: string | null;
};
