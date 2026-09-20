import type { ConnectionStatus } from "../../network/types";
import { cn } from "../../utils/cn";

/**
 * Connection status badge — the lobby's always-visible pulse. Styled like
 * the game Header's phase badges so the two screens read as one app.
 */
const STATUS: Record<
  ConnectionStatus,
  { label: string; className: string; pulse: boolean }
> = {
  disconnected: {
    label: "Disconnected",
    className: "bg-red-500/15 text-red-300 border-red-400/30",
    pulse: false,
  },
  connecting: {
    label: "Connecting…",
    className: "bg-amber-500/15 text-amber-300 border-amber-400/30",
    pulse: true,
  },
  connected: {
    label: "Connected",
    className: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
    pulse: false,
  },
  reconnecting: {
    label: "Reconnecting…",
    className: "bg-amber-500/15 text-amber-300 border-amber-400/30",
    pulse: true,
  },
  closed: {
    label: "Closed",
    className: "bg-white/5 text-white/50 border-white/15",
    pulse: false,
  },
};

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  const badge = STATUS[status];
  return (
    <span
      data-testid="connection-status"
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold",
        badge.className
      )}
    >
      {badge.pulse && (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {badge.label}
    </span>
  );
}
