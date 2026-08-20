"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Script from "next/script";
import { usePathname } from "next/navigation";

const CONSENT_KEY = "sm.storefront-tracking-consent.v1";
const CONSENT_EVENT = "sm:storefront-tracking-consent-change";

interface TrackingConsent {
  version: 1;
  analytics: boolean;
  marketing: boolean;
  decidedAt: string;
}

declare global {
  interface Window {
    dataLayer?: unknown[][];
    gtag?: (...args: unknown[]) => void;
    fbq?: ((...args: unknown[]) => void) & {
      callMethod?: (...args: unknown[]) => void;
      queue?: unknown[][];
      loaded?: boolean;
      version?: string;
      push?: (...args: unknown[]) => void;
    };
    _fbq?: Window["fbq"];
  }
}

function parseConsent(
  serialized: string | null | undefined,
): TrackingConsent | null {
  try {
    const parsed = JSON.parse(
      serialized ?? "null",
    ) as Partial<TrackingConsent> | null;
    if (
      parsed?.version !== 1 ||
      typeof parsed.analytics !== "boolean" ||
      typeof parsed.marketing !== "boolean"
    ) {
      return null;
    }
    return {
      version: 1,
      analytics: parsed.analytics,
      marketing: parsed.marketing,
      decidedAt:
        typeof parsed.decidedAt === "string" ? parsed.decidedAt : "unknown",
    };
  } catch {
    return null;
  }
}

function readConsentSnapshot(): string | null {
  try {
    return localStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
}

function subscribeToConsent(onStoreChange: () => void) {
  function handleStorage(event: StorageEvent) {
    if (event.key === CONSENT_KEY) onStoreChange();
  }

  window.addEventListener("storage", handleStorage);
  window.addEventListener(CONSENT_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CONSENT_EVENT, onStoreChange);
  };
}

export function MerchantTracking({
  storeName,
  ga4MeasurementId,
  metaPixelId,
}: {
  storeName: string;
  ga4MeasurementId: string | null;
  metaPixelId: string | null;
}) {
  const pathname = usePathname();
  const savedConsent = useSyncExternalStore<string | null | undefined>(
    subscribeToConsent,
    readConsentSnapshot,
    () => undefined,
  );
  const [sessionConsent, setSessionConsent] = useState<TrackingConsent | null>(
    null,
  );
  const consent = sessionConsent ?? parseConsent(savedConsent);
  const [managing, setManaging] = useState(false);
  const [analyticsChoice, setAnalyticsChoice] = useState(false);
  const [marketingChoice, setMarketingChoice] = useState(false);
  const [gaReady, setGaReady] = useState(false);
  const [metaReady, setMetaReady] = useState(false);

  useEffect(() => {
    if (!gaReady || !ga4MeasurementId || !consent?.analytics) return;
    window.gtag?.("event", "page_view", {
      page_path: pathname,
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [consent?.analytics, ga4MeasurementId, gaReady, pathname]);

  useEffect(() => {
    if (!metaReady || !metaPixelId || !consent?.marketing) return;
    window.fbq?.("track", "PageView");
  }, [consent?.marketing, metaPixelId, metaReady, pathname]);

  if (!ga4MeasurementId && !metaPixelId) return null;

  function saveChoice(analytics: boolean, marketing: boolean) {
    const next: TrackingConsent = {
      version: 1,
      analytics: Boolean(ga4MeasurementId) && analytics,
      marketing: Boolean(metaPixelId) && marketing,
      decidedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event(CONSENT_EVENT));
    } catch {
      // Privacy-safe failure: the state applies for this page, but a browser
      // that blocks storage is asked again next time rather than assumed opted in.
    }

    window.gtag?.("consent", "update", {
      analytics_storage: next.analytics ? "granted" : "denied",
    });
    window.fbq?.("consent", next.marketing ? "grant" : "revoke");
    setSessionConsent(next);
    setAnalyticsChoice(next.analytics);
    setMarketingChoice(next.marketing);
    setManaging(false);
  }

  const gaAllowed = Boolean(ga4MeasurementId && consent?.analytics);
  const metaAllowed = Boolean(metaPixelId && consent?.marketing);
  const showDialog = consent === null || managing;

  function beginManaging() {
    setAnalyticsChoice(consent?.analytics ?? false);
    setMarketingChoice(consent?.marketing ?? false);
    setManaging(true);
  }

  return (
    <>
      {gaAllowed && ga4MeasurementId ? (
        <>
          <Script
            id={`sm-ga4-init-${ga4MeasurementId}`}
            strategy="afterInteractive"
            onReady={() => setGaReady(true)}
          >{`
window.dataLayer = window.dataLayer || [];
window.gtag = window.gtag || function(){window.dataLayer.push(arguments);};
window.gtag('consent', 'default', {
  analytics_storage: 'granted',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied'
});
window.gtag('js', new Date());
window.gtag('config', '${ga4MeasurementId}', { send_page_view: false });
`}</Script>
          <Script
            id={`sm-ga4-library-${ga4MeasurementId}`}
            src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga4MeasurementId)}`}
            strategy="afterInteractive"
          />
        </>
      ) : null}

      {metaAllowed && metaPixelId ? (
        <Script
          id={`sm-meta-pixel-${metaPixelId}`}
          strategy="afterInteractive"
          onReady={() => setMetaReady(true)}
        >{`
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
window.fbq('init', '${metaPixelId}');
`}</Script>
      ) : null}

      {showDialog ? (
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="sm-privacy-title"
          className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 text-slate-950 shadow-2xl sm:inset-x-6"
        >
          <h2 id="sm-privacy-title" className="text-base font-semibold">
            Your privacy choices
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {storeName} uses optional analytics and marketing tools only with
            your permission. You can shop normally if you reject them. Read the{" "}
            <Link href="/privacy-policy" className="font-semibold underline">
              privacy policy
            </Link>
            .
          </p>

          {managing ? (
            <div className="mt-4 space-y-3 border-y border-slate-100 py-4">
              {ga4MeasurementId ? (
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-slate-950"
                    checked={analyticsChoice}
                    onChange={(event) =>
                      setAnalyticsChoice(event.target.checked)
                    }
                  />
                  <span>
                    <strong className="block">Analytics</strong>
                    <span className="text-slate-600">
                      Allow Google Analytics to measure visits and page views.
                    </span>
                  </span>
                </label>
              ) : null}
              {metaPixelId ? (
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-slate-950"
                    checked={marketingChoice}
                    onChange={(event) =>
                      setMarketingChoice(event.target.checked)
                    }
                  />
                  <span>
                    <strong className="block">Marketing</strong>
                    <span className="text-slate-600">
                      Allow Meta Pixel for advertising measurement and
                      audiences.
                    </span>
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold"
              onClick={() => saveChoice(false, false)}
            >
              Reject optional
            </button>
            {managing ? (
              <button
                type="button"
                className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => saveChoice(analyticsChoice, marketingChoice)}
              >
                Save choices
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold"
                  onClick={beginManaging}
                >
                  Manage choices
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => saveChoice(true, true)}
                >
                  Accept all
                </button>
              </>
            )}
          </div>
        </section>
      ) : consent ? (
        <button
          type="button"
          className="fixed bottom-3 right-3 z-[70] rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-md"
          onClick={beginManaging}
        >
          Privacy choices
        </button>
      ) : null}
    </>
  );
}
