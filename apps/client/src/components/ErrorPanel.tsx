/**
 * Full-area error message with recovery buttons, shared by the error boundaries and the game canvas.
 * Recovery is always possible: "Reload page" works whatever broke, and "Try again" is shown when the caller
 * can retry without a reload.
 */
import type { ReactNode } from "react";

type Props = {
  title: string;
  message: string;
  /** Technical detail for bug reports, shown collapsed. */
  detail?: string;
  /** Retries without reloading the page; omit when the only fix is a reload. */
  onRetry?: () => void;
  children?: ReactNode;
};

export function ErrorPanel({ title, message, detail, onRetry, children }: Props) {
  return (
    <div
      role="alert"
      className="w-full h-screen bg-slate-950 text-slate-200 flex flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <h1 className="text-lg font-semibold text-rose-400">{title}</h1>
      <p className="max-w-md text-sm text-slate-300">{message}</p>
      <div className="flex items-center gap-2">
        {onRetry && (
          <button
            onClick={onRetry}
            className="px-4 py-2 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-sm cursor-pointer"
          >
            Try again
          </button>
        )}
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-white text-sm border border-slate-600 cursor-pointer"
        >
          Reload page
        </button>
      </div>
      {children}
      {detail && (
        <details className="max-w-md text-xs text-slate-400">
          <summary className="cursor-pointer">Technical details</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-left">{detail}</pre>
        </details>
      )}
    </div>
  );
}
