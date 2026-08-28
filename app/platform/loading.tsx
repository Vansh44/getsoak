import { Loader } from "@/components/ui/loader";

// Route-transition fallback for this area only.
//
// ⚠ THIS USED TO LIVE AT app/loading.tsx, AND THAT MADE EVERY 404 A SOFT 404.
// A loading.tsx wraps its subtree in Suspense, so Next flushes the shell — with
// the HTTP status already committed as 200 — before the layout below it runs.
// `notFound()` then renders the right page into a response that has already
// said "200 OK": an unclaimed store subdomain, a missing product and a missing
// custom page all returned 200 with "Page not found" in the body, which is
// exactly the soft-404 Google penalises.
//
// So the boundary is opt-in per area now, and the rule for adding another one
// is: NEVER above a publicly indexable route. The storefront, the help centre
// and the theme catalog therefore have none — their 404s must be real 404s.
// dashboard / platform / pos are auth-gated and noindex, so a Suspense boundary
// costs them nothing and keeps the navigation feedback they had before.
export default function Loading() {
  return (
    <div className="flex h-[50vh] w-full items-center justify-center">
      <Loader />
    </div>
  );
}
