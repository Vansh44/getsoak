"use client";
import { useEffect, useState } from "react";
import type { ApprovedMemory, MemoryKind } from "@/lib/mink/memory-policy";
const blank = () => ({
  id: crypto.randomUUID(),
  requestKey: crypto.randomUUID(),
  version: 0,
  title: "",
  content: "",
  kind: "preference" as MemoryKind,
  days: 90,
});
export function MinkMemoryManager() {
  const [memories, setMemories] = useState<ApprovedMemory[]>([]);
  const [draft, setDraft] = useState(blank);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load(signal?: AbortSignal) {
    const res = await fetch("/api/mink/memories", {
      cache: "no-store",
      signal,
    });
    const body = await res.json();
    if (!res.ok) {
      setMemories([]);
      throw new Error(body.error ?? "Could not load memories.");
    }
    setMemories(body.memories);
    setLoaded(true);
  }
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch((e) => {
      if (!abort.signal.aborted) setError(e.message);
    });
    return () => abort.abort();
  }, []);
  async function change(command: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/mink/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Memory change failed.");
      await load();
      setDraft(blank());
      setConfirmed(false);
      setNotice(
        command.action === "save"
          ? "Memory approved for future chat turns."
          : "Memory deleted. Existing conversations are unchanged.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-5">
      <p className="text-sm">
        Up to 10 memories, 600 characters each. Expired memories are not used.
        Permission or location-access changes require you to review and approve
        a memory again. Memories never approve actions or override your current
        request.
      </p>
      <p className="text-sm">
        Deleting stops use in future turns; it cannot remove context already
        sent to an active run or erase mentions in saved conversations. Delete
        those conversations separately. Context uses normal model input tokens;
        there is no separate memory-save credit charge.
      </p>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        disabled={busy}
        onClick={() => {
          setError("");
          void load().catch((e) => setError(e.message));
        }}
        className="rounded-lg border px-3 py-2"
      >
        Refresh memories
      </button>
      {!loaded && !error && <p role="status">Loading memories…</p>}
      {loaded && !memories.length && <p>No active memories saved.</p>}
      {memories.map((m) => (
        <article key={m.id} className="space-y-2 rounded-xl border p-4">
          <h2 className="font-semibold">{m.title}</h2>
          <p className="whitespace-pre-wrap break-words">{m.content}</p>
          <p className="text-xs">
            {m.kind.replaceAll("_", " ")} · Expires{" "}
            {new Date(m.expiresAt).toLocaleDateString()} · Version {m.version}
          </p>
          {!m.usable && (
            <p className="text-amber-800">
              Not used: your access changed. Edit and approve again if this
              context is still appropriate.
            </p>
          )}
          <div className="flex gap-2">
            <button
              disabled={busy}
              className="rounded-lg border px-3 py-2"
              onClick={() => {
                setDraft({
                  id: m.id,
                  requestKey: crypto.randomUUID(),
                  version: m.version,
                  title: m.title,
                  content: m.content,
                  kind: m.kind,
                  days: 90,
                });
                setConfirmed(false);
              }}
            >
              Edit {m.title}
            </button>
            <button
              disabled={busy}
              className="rounded-lg border px-3 py-2"
              onClick={() => {
                if (
                  window.confirm(
                    `Delete your memory “${m.title}” from this store?`,
                  )
                )
                  void change({
                    action: "delete",
                    id: m.id,
                    version: m.version,
                    confirmed: true,
                  });
              }}
            >
              Delete {m.title}
            </button>
          </div>
        </article>
      ))}
      <form
        className="space-y-3 rounded-xl border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void change({ action: "save", ...draft, confirmed });
        }}
      >
        <fieldset disabled={busy} className="space-y-3">
          <h2 className="font-semibold">
            {draft.version ? "Review memory changes" : "Add an approved memory"}
          </h2>
          <label className="block">
            Title
            <input
              required
              maxLength={80}
              value={draft.title}
              className="mt-1 block w-full rounded-lg border p-2"
              onChange={(e) => {
                setDraft({
                  ...draft,
                  title: e.target.value,
                  requestKey: crypto.randomUUID(),
                });
                setConfirmed(false);
              }}
            />
          </label>
          <label className="block">
            Category
            <select
              value={draft.kind}
              className="ml-2 rounded-lg border p-2"
              onChange={(e) => {
                setDraft({
                  ...draft,
                  kind: e.target.value as MemoryKind,
                  requestKey: crypto.randomUUID(),
                });
                setConfirmed(false);
              }}
            >
              <option value="preference">Answer preference</option>
              <option value="brand_voice">Brand voice</option>
              <option value="business_context">Business context</option>
            </select>
          </label>
          <label className="block">
            Memory
            <textarea
              required
              maxLength={600}
              rows={4}
              value={draft.content}
              className="mt-1 block w-full rounded-lg border p-2"
              onChange={(e) => {
                setDraft({
                  ...draft,
                  content: e.target.value,
                  requestKey: crypto.randomUUID(),
                });
                setConfirmed(false);
              }}
            />
          </label>
          <label className="block">
            Keep for
            <select
              value={draft.days}
              className="ml-2 rounded-lg border p-2"
              onChange={(e) => {
                setDraft({
                  ...draft,
                  days: Number(e.target.value),
                  requestKey: crypto.randomUUID(),
                });
                setConfirmed(false);
              }}
            >
              {[30, 90, 365].map((d) => (
                <option value={d} key={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I reviewed this exact text and approve using it as context in my
            future chats in this store.
          </label>
          <div className="flex gap-2">
            <button
              disabled={
                busy ||
                !confirmed ||
                !draft.title.trim() ||
                !draft.content.trim()
              }
              className="rounded-lg bg-[#6d4dff] px-3 py-2 text-white disabled:opacity-40"
            >
              Approve and save memory
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-lg border px-3 py-2"
              onClick={() => {
                setDraft(blank());
                setConfirmed(false);
              }}
            >
              Clear form
            </button>
          </div>
        </fieldset>
      </form>
      {loaded && (
        <button
          disabled={busy}
          className="rounded-lg border px-3 py-2 text-red-700"
          onClick={() => {
            if (
              window.confirm(
                "Permanently delete all your memories in this store? Other admins and conversations are unaffected.",
              )
            )
              void change({ action: "delete_all", confirmed: true });
          }}
        >
          Delete all my memories
        </button>
      )}
    </section>
  );
}
