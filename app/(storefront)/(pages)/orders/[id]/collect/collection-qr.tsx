"use client";

// The QR a customer holds up at the counter (roadmap Step 3).
//
// ★ RENDERED HERE, NOT IN THE EMAIL. Gmail strips `data:` URIs in <img> and
// every major client blocks remote images by default, so a QR emailed inline is
// a broken-image icon on the one screen that matters. The email carries the
// CODE as text and links here; this page draws the QR.
//
// ★ CLIENT-SIDE, WITH NO NEW DEPENDENCY. @zxing/browser is already installed
// for camera scanning and ships BrowserQRCodeSvgWriter, so this costs an
// existing package rather than another one — and an SVG scales to whatever the
// scanner needs without a server round trip or an image to host.
//
// ★ THE CODE IN TEXT IS THE PRIMARY, THE QR IS THE CONVENIENCE. If the writer
// fails to load, or the shop's scanner is broken, or the screen is cracked, the
// customer can still read eight characters aloud. So the text is never
// conditional on the QR working.

import { useEffect, useRef, useState } from "react";
import { formatCollectionCode } from "@/lib/fulfilment/collection-code";
import styles from "../../orders.module.css";

export function CollectionQr({ code }: { code: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const el = holder.current;
    if (!el) return;

    void (async () => {
      try {
        // Lazy: the writer is only needed on this page, and it is the one
        // heavy import in the storefront bundle otherwise.
        const { BrowserQRCodeSvgWriter } = await import("@zxing/browser");
        if (cancelled || !holder.current) return;
        holder.current.replaceChildren();
        new BrowserQRCodeSvgWriter().writeToDom(holder.current, code, 220, 220);
      } catch {
        // The code below still works. A missing QR is an inconvenience; a page
        // that renders nothing is a customer who cannot collect.
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div className={styles.collectQrWrap}>
      {!failed && <div ref={holder} aria-hidden="true" />}
      <p className={styles.collectCode}>{formatCollectionCode(code)}</p>
      <p className={styles.collectCodeHint}>
        {failed
          ? "Read this code out at the counter."
          : "Show this code, or read it out at the counter."}
      </p>
    </div>
  );
}
