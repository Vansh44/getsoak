"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { WATCH_KINDS } from "@/lib/mink/watch-policy";
import type { WatchView } from "@/lib/mink/watches";
import { MinkBusinessBrief } from "../mink-business-brief";

type Data = { watches: WatchView[]; locations: string[]; timeZone: string };
const LABELS = {
  brief: "Business brief",
  inventory: "Low or out-of-stock inventory",
  sales: "Sales decline",
  returns: "Rising return activity",
  payments: "Failed-payment orders",
};
const field = "w-full rounded-lg border bg-background p-2";
const button = "rounded-lg border px-3 py-2 disabled:opacity-50";
export function MinkWatchManager() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quiet, setQuiet] = useState(true);
  const [weekly, setWeekly] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const creationKey = useRef<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/mink/watches", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) {
      setData(null);
      throw new Error(body.error ?? "Could not load watches.");
    }
    setData(body);
  }, []);
  useEffect(() => {
    let alive = true;
    void load().catch((e) => {
      if (alive) setError(e.message);
    });
    return () => {
      alive = false;
    };
  }, [load]);
  async function mutate(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/mink/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Could not change watch.");
      if (body.action === "create") {
        creationKey.current = null;
        setConfirmed(false);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 p-3 text-red-700"
        >
          {error}
        </p>
      )}
      <button
        className={button}
        disabled={busy}
        onClick={() => {
          setError("");
          void load().catch((e) => setError(e.message));
        }}
      >
        Refresh watches
      </button>
      {!data ? (
        !error && <p role="status">Loading watches…</p>
      ) : (
        <>
          <form
            ref={form}
            className="space-y-4 rounded-xl border bg-background p-5"
            onChange={(event) => {
              creationKey.current = null;
              if (
                !(event.target instanceof HTMLInputElement) ||
                event.target.name !== "consent"
              )
                setConfirmed(false);
            }}
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              creationKey.current ??= crypto.randomUUID();
              void mutate({
                action: "create",
                confirmed,
                creationKey: creationKey.current,
                kind: values.get("kind"),
                locationName: values.get("location") || undefined,
                schedule: {
                  frequency: weekly ? "weekly" : "daily",
                  time: values.get("time"),
                  weekday: Number(values.get("weekday") ?? 1),
                  quietStart: quiet ? values.get("quietStart") : null,
                  quietEnd: quiet ? values.get("quietEnd") : null,
                },
              });
            }}
          >
            <h2 className="font-semibold">Create a watch</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                Check
                <select name="kind" className={field}>
                  {WATCH_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Location
                <select name="location" className={field}>
                  <option value="">All currently accessible locations</option>
                  {data.locations.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label>
                Repeat
                <select
                  className={field}
                  value={weekly ? "weekly" : "daily"}
                  onChange={(e) => setWeekly(e.target.value === "weekly")}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
              <label>
                Check time ({data.timeZone})
                <input
                  className={field}
                  name="time"
                  type="time"
                  required
                  defaultValue="09:00"
                />
              </label>
              {weekly && (
                <label>
                  Day
                  <select className={field} name="weekday" defaultValue="1">
                    {[
                      "Sunday",
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                    ].map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={quiet}
                onChange={(e) => setQuiet(e.target.checked)}
              />
              Quiet hours for notifications
            </label>
            {quiet && (
              <div className="grid grid-cols-2 gap-3">
                <label>
                  From
                  <input
                    className={field}
                    name="quietStart"
                    type="time"
                    required
                    defaultValue="22:00"
                  />
                </label>
                <label>
                  Until
                  <input
                    className={field}
                    name="quietEnd"
                    type="time"
                    required
                    defaultValue="08:00"
                  />
                </label>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              Sales, returns and payment checks cover completed local days, not
              live incidents. Stock is checked per location at run time. Briefs
              notify each scheduled period; other watches notify on new
              attention. Unchanged conditions stay quiet. Quiet hours defer and
              coalesce alerts. No email, SMS, extra Gemini call or automatic
              business action.
            </p>
            <p className="text-sm text-muted-foreground">
              Up to 5 watches per admin and 20 per store, including paused
              watches. The selected scope, timezone and inventory threshold are
              captured now. New locations do not join automatically. Check time
              is approximate; missed schedules do not produce a catch-up burst.
            </p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                name="consent"
                onChange={(e) => setConfirmed(e.target.checked)}
                required
              />
              I reviewed these settings and want to enable recurring checks and
              private in-app notifications.
            </label>
            <button
              className={`${button} bg-violet-600 text-white`}
              disabled={busy || !confirmed || data.watches.length >= 5}
            >
              Enable watch
            </button>
          </form>
          <section className="space-y-4" aria-label="Your watches">
            <h2 className="font-semibold">
              Your watches ({data.watches.length}/5)
            </h2>
            {data.watches.length === 0 && (
              <p>
                No watches enabled. A one-off brief does not create a watch.
              </p>
            )}
            {data.watches.map((w) => (
              <article
                className="space-y-3 rounded-xl border bg-background p-5"
                key={w.id}
              >
                <h3 className="font-semibold">
                  {LABELS[w.kind as keyof typeof LABELS]} · {w.locationLabel}
                </h3>
                <p className="text-sm">
                  {w.status} · {w.schedule.frequency} at {w.schedule.time} ·{" "}
                  {w.timeZone}
                </p>
                {w.status === "active" && (
                  <p className="text-sm">
                    Next check:{" "}
                    {new Date(w.nextRunAt).toLocaleString("en-IN", {
                      timeZone: w.timeZone,
                    })}{" "}
                    ({w.timeZone})
                  </p>
                )}
                {w.errorCode && (
                  <p role="status" className="text-sm text-amber-700">
                    {w.errorCode === "authorization_revoked"
                      ? "Access or location scope changed. Review your permissions; recreate this watch if its scope changed."
                      : "The check could not complete. This is not an all-clear. The watch is paused; review access and resume to try at the next scheduled time."}
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void mutate({
                        action: w.status === "paused" ? "resume" : "pause",
                        id: w.id,
                        version: w.version,
                      })
                    }
                  >
                    {w.status === "paused" ? "Resume" : "Pause"}
                  </button>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Delete this watch? Pending checks and alerts will stop. This cannot be undone.",
                        )
                      )
                        void mutate({
                          action: "delete",
                          id: w.id,
                          version: w.version,
                        });
                    }}
                  >
                    Delete
                  </button>
                </div>
                {w.result ? (
                  <details>
                    <summary className="cursor-pointer">
                      Latest completed check ·{" "}
                      {new Date(w.result.dataAsOf).toLocaleString("en-IN", {
                        timeZone: w.timeZone,
                      })}
                    </summary>
                    <div className="mt-3">
                      <MinkBusinessBrief result={w.result} />
                    </div>
                  </details>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No accessible completed check yet.
                  </p>
                )}
              </article>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
