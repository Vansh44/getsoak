// Builds the URL for the dynamic branded OG card (app/api/og). Returns a
// store-relative path — the page's metadataBase absolutizes it — so the same
// helper works on every store host. Used as the default og:image for pages
// that have no image of their own (homepage, custom pages, platform landing).
//
// All fields are packed into a SINGLE `d` query param (JSON, form-encoded by
// URLSearchParams so any `&` inside becomes %26). This is deliberate: a
// multi-param URL would carry raw `&`, which Next.js HTML-encodes to `&amp;`
// inside the <meta> tag, and some crawlers (notably WhatsApp) fetch that
// literally and drop the later params — the same lesson lib/og-image.ts encodes.
export function brandOgImageUrl(params: {
  title: string;
  subtitle?: string | null;
  color?: string | null;
  /** A path under public/brand — StoreMink's own surfaces only. A store's card
   *  stays logo-less rather than carrying our mark (see the route). */
  logo?: string | null;
  /** Small line under the rule. Defaults to the title. */
  footer?: string | null;
}): string {
  const payload: Record<string, string> = { title: params.title };
  if (params.subtitle) payload.subtitle = params.subtitle;
  if (params.color) payload.color = params.color;
  if (params.logo) payload.logo = params.logo;
  if (params.footer) payload.footer = params.footer;
  const sp = new URLSearchParams({ d: JSON.stringify(payload) });
  return `/api/og?${sp.toString()}`;
}
