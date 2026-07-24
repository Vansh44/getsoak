"use client";

import { useEffect, useState } from "react";
import {
  recordHelpArticleView,
  voteHelpArticle,
} from "@/app/actions/help-actions";

// "Was this helpful?" — one vote per article per browser (localStorage guard,
// best-effort anti-spam; the DB counters are relative-increment only). Also
// bumps the view count once on mount.
export function FeedbackWidget({ articleId }: { articleId: string }) {
  const [voted, setVoted] = useState<null | boolean>(null);
  const [busy, setBusy] = useState(false);

  const key = `hc-voted-${articleId}`;
  const viewKey = `hc-viewed-${articleId}`;

  useEffect(() => {
    // Record a view once per session-ish (per browser) so refreshes don't inflate.
    try {
      if (!sessionStorage.getItem(viewKey)) {
        sessionStorage.setItem(viewKey, "1");
        void recordHelpArticleView(articleId);
      }
      const prior = localStorage.getItem(key);
      if (prior === "yes") setVoted(true);
      else if (prior === "no") setVoted(false);
    } catch {
      /* storage may be unavailable (private mode) — degrade to allowing a vote */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId]);

  async function vote(helpful: boolean) {
    if (voted !== null || busy) return;
    setBusy(true);
    const res = await voteHelpArticle(articleId, helpful);
    setBusy(false);
    if (!res.error) {
      setVoted(helpful);
      try {
        localStorage.setItem(key, helpful ? "yes" : "no");
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <div className="hc-feedback">
      {voted === null ? (
        <>
          <p>Was this article helpful?</p>
          <div className="btns">
            <button onClick={() => vote(true)} disabled={busy}>
              👍 Yes
            </button>
            <button onClick={() => vote(false)} disabled={busy}>
              👎 No
            </button>
          </div>
        </>
      ) : (
        <p className="thanks">
          {voted
            ? "Thanks for your feedback! 🎉"
            : "Thanks — we'll use this to improve the docs."}
        </p>
      )}
    </div>
  );
}
