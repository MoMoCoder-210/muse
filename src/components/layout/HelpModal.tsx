type HelpModalProps = {
  version: string;
  onClose: () => void;
};

/**
 * 帮助 / 关于弹窗
 *
 * 复用通用 .modal-backdrop / .modal-panel 样式，展示版本与基础使用指引。
 */
export function HelpModal({ version, onClose }: HelpModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel help-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">帮助</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className="help-body">
          <p>
            <strong>Muse</strong> · 版本 {version}
          </p>
          <ul>
            <li>拖动顶部标题栏可移动窗口；右上角按钮控制窗口与打开设置 / 帮助。</li>
            <li>点击「新建项目」后，在左侧项目列表中选择项目进入工作区。</li>
            <li>工作区按流程阶段推进：分镜脚本 → 资产管理 → 分镜生成 → 视频合成。</li>
            <li>点击标题栏齿轮可配置生图渠道等应用设置。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
