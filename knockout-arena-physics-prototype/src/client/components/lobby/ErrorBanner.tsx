/**
 * Dismissible banner for the latest server error. Errors are DATA surfaced
 * by the network client (lastError) — the lobby never throws on them and
 * never retries an action behind the user's back; it just shows what the
 * server said.
 */
export interface ErrorBannerProps {
  error: { readonly code: string; readonly message: string };
  onDismiss: () => void;
}

export function ErrorBanner({ error, onDismiss }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      data-testid="error-banner"
      className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3"
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold text-red-300">Server error</p>
        <p className="mt-0.5 break-words text-sm text-red-200/80">
          {error.message}{" "}
          <span className="font-mono text-xs text-red-300/60">
            ({error.code})
          </span>
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="shrink-0 rounded-lg border border-red-400/20 px-2 py-1 text-xs font-bold text-red-300/70 transition-colors hover:bg-red-500/15 hover:text-red-200"
      >
        ✕
      </button>
    </div>
  );
}
