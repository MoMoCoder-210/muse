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
