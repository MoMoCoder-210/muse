import type { AssetCardData } from "./AssetCard";

type DeleteAssetConfirmProps = {
  /** 待删除的资产列表 */
  cards: AssetCardData[];
  onConfirm: (cards: AssetCardData[]) => void;
  onCancel: () => void;
  disabled?: boolean;
};

/**
 * 资产删除确认弹窗。
 *
 * 复用项目删除/片段删除弹窗的样式，支持单个或批量确认。
 *
 * @author yt @date 20260704
 */
export function DeleteAssetConfirm({ cards, onConfirm, onCancel, disabled }: DeleteAssetConfirmProps) {
  const count = cards.length;
  const first = cards[0];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="modal-panel clip-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="delete-confirm-title">删除资产</h2>
          <button
            type="button"
            className="icon-button modal-close-button"
            aria-label="关闭"
            onClick={onCancel}
            disabled={disabled}
          >
            ×
          </button>
        </div>
        <p className="clip-delete-modal-text">
          {count === 1
            ? <>确认删除资产 <strong>「{first.resource.name}」</strong>？</>
            : <>确认删除 <strong>{count}</strong> 个资产？</>
          }
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary-button btn-sm" onClick={onCancel} disabled={disabled}>
            取消
          </button>
          <button type="button" className="danger-button btn-sm" onClick={() => onConfirm(cards)} disabled={disabled}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
