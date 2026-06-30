export type ProjectInfo = {
  id: string;
  name: string;
  description: string;
  workspace_path: string;
  status: string;
  current_step: string;
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
  raw_content: string;
  normalized_content: string;
  split_status: "pending" | "running" | "success" | "failed";
  error_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
};

export type ClipStatus =
  | "pending"
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
