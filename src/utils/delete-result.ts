export type FileDeletionResult = {
  deleted_file_count: number;
  failed_file_count: number;
};

export const EMPTY_FILE_DELETION_RESULT: FileDeletionResult = {
  deleted_file_count: 0,
  failed_file_count: 0,
};

/** 汇总多个独立删除请求的本地文件清理结果。 */
export function mergeFileDeletionResults(results: readonly FileDeletionResult[]): FileDeletionResult {
  return results.reduce(
    (total, result) => ({
      deleted_file_count: total.deleted_file_count + result.deleted_file_count,
      failed_file_count: total.failed_file_count + result.failed_file_count,
    }),
    EMPTY_FILE_DELETION_RESULT,
  );
}

/**
 * 所有删除入口共用的单条提示文案。
 * 本地文件删除出现失败时，数据库删除虽可能已提交，仍以失败状态提示用户处理残留文件。
 */
export function formatDeleteResult(
  result: FileDeletionResult = EMPTY_FILE_DELETION_RESULT,
  operationFailed = false,
): { text: string; kind: "success" | "error" } {
  const failed = operationFailed || result.failed_file_count > 0;
  return {
    text: `删除${failed ? "失败" : "成功"}，已删除 ${result.deleted_file_count} 个文件，${result.failed_file_count} 个文件删除失败`,
    kind: failed ? "error" : "success",
  };
}
