"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { DEFAULT_CHROME, type StoreChrome } from "@/lib/chrome/types";

const ChromeContext = createContext<StoreChrome | null>(null);

/**
 * The current store's header + footer configuration.
 *
 * Supersedes MenuProvider, which carried only the link lists. The chrome now
 * also decides whether the search box, cart, newsletter, contact strip, social
 * row and badges render at all, so Header and Footer read this one object
 * instead of reaching into three different sources.
 *
 * In the builder's preview iframe it also listens for `sm-chrome` postMessages
 * so header/footer edits paint instantly, the same way DraftCanvas handles
 * page sections. Without that, editing the header would need a full iframe
 * reload per keystroke and the builder would feel broken next to the rest of
 * its own UI.
 */
export function ChromeProvider({
  chrome,
  live = false,
  children,
}: {
  chrome: StoreChrome;
  /** Preview mode: accept live updates from the builder. */
  live?: boolean;
  children: React.ReactNode;
}) {
  const [value, setValue] = useState<StoreChrome>(chrome);

  // Server-rendered chrome changes on navigation (and on router.refresh after
  // publish); adopt it, or the preview would keep showing a stale draft.
  useEffect(() => setValue(chrome), [chrome]);

  useEffect(() => {
    if (!live) return;
    const onMessage = (e: MessageEvent) => {
      // Same-origin only. The preview iframe is served from the store's own
      // host, so anything from elsewhere is not the builder.
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; chrome?: StoreChrome } | null;
      if (data?.type === "sm-chrome" && data.chrome) setValue(data.chrome);
    };
    window.addEventListener("message", onMessage);
    // Tell the builder we're ready for draft pushes — it may have mounted
    // first and sent its state before this listener existed.
    window.parent?.postMessage(
      { type: "sm-chrome-ready" },
      window.location.origin,
    );
    return () => window.removeEventListener("message", onMessage);
  }, [live]);

  return (
    <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>
  );
}

/** Falls back to the defaults outside a provider, so no consumer can crash. */
export function useChrome(): StoreChrome {
  return useContext(ChromeContext) ?? DEFAULT_CHROME;
}
