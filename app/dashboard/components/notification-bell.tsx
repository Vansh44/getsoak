"use client";

// The topbar bell. Until now this was a decorative icon with a hardcoded red
// dot; it is now the real inbox.
//
// DELIVERY MECHANISM: polling, not push — the same choice (and the same
// visibility gating) as RealtimeRefresher. Supabase Realtime went away with
// the Cloud SQL migration and plain Postgres can't push row changes to a
// browser, so the badge polls a count query that hits a partial index, and
// only while the tab is actually being looked at. A Postgres LISTEN/NOTIFY →
// SSE service is the eventual upgrade; nothing here would have to change but
// the refresh trigger.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import {
  getMyNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationRow,
} from "@/app/actions/notification-actions";

const POLL_MS = 45_000;

const SEVERITY_DOT: Record<string, string> = {
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  critical: "bg-red-500",
};

/** "just now" / "12m" / "3h" / "5d" — compact enough for a dropdown row. */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(async () => {
    try {
      setUnread(await getUnreadNotificationCount());
    } catch {
      // A failed poll is not worth surfacing — the next tick retries.
    }
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getMyNotifications();
      setItems(result.notifications);
      setUnread(result.unread);
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll only while the tab is visible, and catch up immediately on return.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(refreshCount, POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshCount();
        start();
      } else {
        stop();
      }
    };

    void refreshCount();
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshCount]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void loadItems();
  };

  const handleOpenItem = async (item: NotificationRow) => {
    setOpen(false);
    // Optimistic: the row greys out instantly, the write follows.
    if (!item.read_at) {
      setItems(
        (prev) =>
          prev?.map((n) =>
            n.id === item.id ? { ...n, read_at: new Date().toISOString() } : n,
          ) ?? prev,
      );
      setUnread((n) => Math.max(0, n - 1));
      void markNotificationRead(item.id);
    }
    if (item.url) router.push(item.url);
  };

  const handleMarkAll = async () => {
    setItems(
      (prev) =>
        prev?.map((n) => ({
          ...n,
          read_at: n.read_at ?? new Date().toISOString(),
        })) ?? prev,
    );
    setUnread(0);
    await markAllNotificationsRead();
  };

  const badge = unread > 99 ? "99+" : String(unread);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        aria-label={
          unread > 0 ? `Notifications (${unread} unread)` : "Notifications"
        }
        aria-expanded={open}
        className={`relative flex h-8 w-8 items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-slate-700 hover:text-white ${
          open ? "bg-slate-700 text-white" : ""
        }`}
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span
            className={`absolute -right-0.5 -top-0.5 flex items-center justify-center rounded-full bg-red-500 text-[9px] font-bold leading-none text-white ring-2 ring-[#3f3f46] ${
              unread > 9 ? "h-[15px] min-w-[15px] px-1" : "h-[14px] w-[14px]"
            }`}
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="fixed inset-x-3 top-16 z-[200] flex max-h-[calc(100dvh-5rem)] w-auto flex-col overflow-hidden overscroll-contain rounded-[var(--dash-radius)] border border-[var(--dash-border-strong)] bg-[var(--dash-surface)] shadow-[var(--dash-shadow-lg)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+8px)] sm:max-h-[70vh] sm:w-[min(380px,calc(100vw-24px))]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--dash-border)] px-4 py-3">
            <div className="text-[13px] font-semibold text-[var(--dash-text)]">
              Notifications
              {unread > 0 && (
                <span className="ml-1.5 text-[var(--dash-text-3)]">
                  {unread} new
                </span>
              )}
            </div>
            {unread > 0 && (
              <button
                type="button"
                onClick={handleMarkAll}
                className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--dash-text-2)] transition-colors hover:text-[var(--dash-text)]"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && items === null ? (
              <div className="flex items-center justify-center gap-2 px-4 py-10 text-[13px] text-[var(--dash-text-3)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : !items || items.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <Bell className="mx-auto h-6 w-6 text-[var(--dash-text-3)] opacity-50" />
                <p className="mt-2 text-[13px] font-medium text-[var(--dash-text-2)]">
                  You&apos;re all caught up
                </p>
                <p className="mt-0.5 text-[12px] text-[var(--dash-text-3)]">
                  New orders and alerts will show up here.
                </p>
              </div>
            ) : (
              <ul>
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => handleOpenItem(item)}
                      className={`flex w-full items-start gap-2.5 border-b border-[var(--dash-border)] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[var(--dash-surface-2)] ${
                        item.read_at ? "opacity-65" : ""
                      }`}
                    >
                      <span
                        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                          SEVERITY_DOT[item.severity] ?? SEVERITY_DOT.info
                        } ${item.read_at ? "opacity-40" : ""}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[13px] font-semibold text-[var(--dash-text)]">
                            {item.title}
                          </span>
                          <span className="shrink-0 text-[11px] text-[var(--dash-text-3)]">
                            {timeAgo(item.created_at)}
                          </span>
                        </span>
                        {item.body && (
                          <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-[var(--dash-text-2)]">
                            {item.body}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-[var(--dash-border)] bg-[var(--dash-surface-2)] px-4 py-2.5">
            <Link
              href="/dashboard/logs"
              onClick={() => setOpen(false)}
              className="text-[12.5px] font-medium text-[var(--dash-accent)] hover:underline"
            >
              View all activity
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
