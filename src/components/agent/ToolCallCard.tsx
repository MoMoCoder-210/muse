/**
 * ToolCallCard：工具调用确认卡片
 */
type Props = {
  confirmation: { toolName: string; params: Record<string, unknown> };
  onApprove: () => void;
  onReject: () => void;
};

export function ToolCallCard({ confirmation, onApprove, onReject }: Props) {
  return (
    <div className="tool-call-card">
      <div className="tool-call-card__header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <polyline points="16 3 21 3 21 8" />
          <line x1="4" y1="20" x2="21" y2="3" />
          <polyline points="21 16 21 21 16 21" />
          <line x1="15" y1="15" x2="21" y2="21" />
          <line x1="4" y1="4" x2="9" y2="9" />
        </svg>
        <span className="tool-call-card__title">工具调用确认</span>
      </div>
      <div className="tool-call-card__body">
        <span className="tool-call-card__tool-name">{confirmation.toolName}</span>
        <pre className="tool-call-card__params">{JSON.stringify(confirmation.params, null, 2)}</pre>
      </div>
      <div className="tool-call-card__actions">
        <button type="button" className="tool-call-card__btn tool-call-card__btn--approve" onClick={onApprove}>批准</button>
        <button type="button" className="tool-call-card__btn tool-call-card__btn--reject" onClick={onReject}>拒绝</button>
      </div>
    </div>
  );
}
