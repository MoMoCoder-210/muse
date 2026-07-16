/**
 * 片段「已拆解」判定。
 *
 * 拆解任务（generate_clip_script）成功后将片段状态置为 script_ready，
 * 其后各 *_ready / done 为兼容预留。仅这些状态视为已拆解，
 * 作为片段列表（分镜管理 / 资产管理 / 视频编辑）的统一过滤口径。
 */
export const DECOMPOSED_STATUSES = [
  "script_ready",
  "asset_ready",
  "storyboard_ready",
  "media_ready",
  "done",
] as const;

export function isClipDecomposed(status: string): boolean {
  return (DECOMPOSED_STATUSES as readonly string[]).includes(status);
}
