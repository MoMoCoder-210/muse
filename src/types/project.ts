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
  /** @author yt @date 20260702 修正类型与实际返回不一致的问题 */
  raw_content?: string;
  normalized_content?: string;
  split_status: "pending" | "running" | "success" | "failed";
  error_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
};

/** @author yt @date 20260703 剧本源列表项（不含原文内容，仅元数据） */
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

/** @author yt @date 20260702 新增片段级写操作类型 */

/** 批量删除片段（软删除） */
export type DeleteClipsInput = {
  clip_ids: string[];
};

/** 更新片段，三个内容字段均可选，传哪个改哪个 */
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

/** @author yt @date 20260702 拆解类型 */

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
