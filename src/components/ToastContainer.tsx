import { ToastMessage } from '../types/weapon';

interface Props {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-20 left-4 z-50 flex flex-col gap-2"
    >
      {toasts.map((t) => {
        const borderClass =
          t.tone === 'success'
            ? 'border-[#10B981]/50 text-[#D1FAE5]'
            : t.tone === 'warning'
              ? 'border-[#F59E0B]/50 text-[#FEF3C7]'
              : 'border-[#2B3342] text-[#E6E9EE]';

        return (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex items-center gap-3 rounded-lg border bg-[#12161E] px-3.5 py-2 text-xs font-medium shadow-lg ${borderClass}`}
          >
            <span>{t.message}</span>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss notification"
              className="text-[#8F99A8] hover:text-[#E6E9EE] transition-colors"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
