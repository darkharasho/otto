interface ApprovalCardProps {
  decisionId: string;
  tool: string;
  actionClass: string;
  summary: string;
  onResolve(decision: 'approve' | 'deny'): void;
}

const CLASS_COLORS: Record<string, string> = {
  read: 'bg-emerald-600',
  reversible: 'bg-blue-600',
  destructive: 'bg-orange-600',
  irreversible: 'bg-red-600',
};

export function ApprovalCard(props: ApprovalCardProps): JSX.Element {
  const color = CLASS_COLORS[props.actionClass] ?? 'bg-gray-600';
  return (
    <div className="otto-elevated rounded-[10px] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-sm">{props.tool}</span>
        <span className={`text-xs text-white rounded px-2 py-0.5 ${color}`}>{props.actionClass}</span>
      </div>
      <div className="text-sm text-muted line-clamp-3 whitespace-pre-wrap break-words">{props.summary}</div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => props.onResolve('deny')}
          className="flex-1 rounded-md border border-border bg-bg/60 text-muted py-2 text-sm font-medium hover:text-text"
        >
          Deny
        </button>
        <button
          onClick={() => props.onResolve('approve')}
          className="otto-send flex-1 rounded-md py-2 text-sm font-medium"
        >
          Approve
        </button>
      </div>
    </div>
  );
}
