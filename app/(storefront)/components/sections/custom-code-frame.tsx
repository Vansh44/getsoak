"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CODE_HEIGHT_MAX,
  CODE_HEIGHT_MIN,
  type CustomCodeConfig,
} from "@/lib/homepage/section-types";

// ---------------------------------------------------------------------------
// Sandboxed renderer for merchant-authored HTML/CSS/JS.
//
// SECURITY MODEL — do not weaken:
//  • Live sections use sandbox="allow-scripts allow-popups"; strict Mink
//    previews use only "allow-scripts". NEVER add "allow-same-origin".
//    Supabase auth cookies are httpOnly:false with Domain=.storemink.com, so
//    same-origin merchant JS could read a visitor's session that is valid on
//    EVERY store subdomain and the platform. The srcDoc iframe gets an opaque
//    origin instead: no cookies, no storage, no parent DOM.
//  • No allow-top-navigation: a section must not be able to redirect visitors.
//    <base target="_blank"> keeps merchant links working (new tab).
//  • The only channel out is postMessage; the parent accepts ONLY a height
//    number from its own iframe's contentWindow, clamped to sane bounds.
//  • If a CSP is ever added to the app, note srcDoc frames INHERIT the
//    embedder's CSP — carve out inline script/style for these frames; the
//    sandbox attribute (not CSP) is the actual security boundary here.
// ---------------------------------------------------------------------------

// Prevent merchant strings from closing our wrapper tags and escaping into the
// document we compose (classic "</script>" breakout).
function escapeScriptClose(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1");
}
function escapeStyleClose(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

// Reports the content height to the parent. Runs inside the sandbox, so
// `parent.postMessage(..., "*")` is required (an opaque-origin frame cannot
// name its parent's origin) and safe (payload is just a number + marker).
//
// Measures document.body (not documentElement): the <html> element's
// scrollHeight is floored at the iframe's own viewport height, so using it
// would trap the frame at its initial fallback height and never let it shrink
// to fit shorter content. The body height is `auto`, so it shrink-wraps.
const RESIZE_SNIPPET = `(function(){
  var send=function(){
    var b=document.body;if(!b)return;
    var h=Math.max(b.scrollHeight,b.offsetHeight);
    parent.postMessage({source:"sm-cc",height:h},"*");
  };
  if(window.ResizeObserver){var ro=new ResizeObserver(send);ro.observe(document.body);}
  window.addEventListener("load",send);
  setTimeout(send,60);setTimeout(send,600);
})();`;

const STRICT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

function buildSrcDoc(
  config: CustomCodeConfig,
  strictNetworkIsolation: boolean,
): string {
  const parts = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    strictNetworkIsolation
      ? `<meta http-equiv="Content-Security-Policy" content="${STRICT_PREVIEW_CSP}">`
      : "",
    "<style>html,body{margin:0;padding:0}</style>",
    config.css ? `<style>${escapeStyleClose(config.css)}</style>` : "",
    strictNetworkIsolation
      ? "</head><body>"
      : '<base target="_blank"></head><body>',
    config.html,
    config.js
      ? `<script>try{${escapeScriptClose(config.js)}\n}catch(e){console.error("[custom code]",e)}</script>`
      : "",
    config.height_mode === "auto" ? `<script>${RESIZE_SNIPPET}</script>` : "",
    "</body></html>",
  ];
  return parts.join("");
}

export function CustomCodeFrame({
  config,
  title = "Custom section",
  strictNetworkIsolation = false,
}: {
  config: CustomCodeConfig;
  title?: string;
  /** Phase 7B previews allow inline proposal code but no external resources. */
  strictNetworkIsolation?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [autoHeight, setAutoHeight] = useState<number | null>(null);

  const srcDoc = useMemo(
    () => buildSrcDoc(config, strictNetworkIsolation),
    [config, strictNetworkIsolation],
  );

  useEffect(() => {
    if (config.height_mode !== "auto") return;
    function onMessage(event: MessageEvent) {
      // Only our own frame, only our marker, only a numeric height.
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { source?: string; height?: unknown };
      if (data?.source !== "sm-cc" || typeof data.height !== "number") return;
      const clamped = Math.min(
        CODE_HEIGHT_MAX,
        Math.max(CODE_HEIGHT_MIN, Math.ceil(data.height)),
      );
      setAutoHeight(clamped);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [config.height_mode]);

  const height =
    config.height_mode === "fixed"
      ? config.fixed_height
      : (autoHeight ?? config.fixed_height);

  return (
    <iframe
      ref={iframeRef}
      sandbox={
        strictNetworkIsolation ? "allow-scripts" : "allow-scripts allow-popups"
      }
      srcDoc={srcDoc}
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      style={{ width: "100%", height, border: 0, display: "block" }}
    />
  );
}
