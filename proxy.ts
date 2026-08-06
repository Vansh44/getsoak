import { type NextRequest, NextResponse } from "next/server";
import { parseHost, isHelpHost, isThemesHost } from "@/lib/store/host";
import { canonicalHostForSlug } from "@/lib/store/canonical";
import { logError } from "@/lib/observability/logger";
import { SESSION_COOKIE, verifySessionCookie } from "@/lib/auth/session-cookie";
import {
  POS_DEVICE_COOKIE,
  POS_OPERATOR_COOKIE,
  verifyDeviceToken,
  verifyOperatorToken,
} from "@/lib/pos/session";

// POS routes served without any POS credential (see the /pos gate below).
const POS_PUBLIC_PATHS = ["/pos/login", "/pos/register", "/pos/reset"];

// File types served from public/ (today: ico, svg, txt, webp) plus the ones a
// future asset or app route would plausibly use. Deliberately explicit: see the
// note at the call site for what a permissive version cost us.
const ASSET_EXTENSION =
  /\.(?:avif|css|eot|gif|ico|jpe?g|js|json|map|mp4|otf|pdf|png|svg|ttf|txt|webm|webp|woff2?|xml|zip)$/i;

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");

  // --- Static public assets (e.g. /themes/arcade/preview.webp, svgs) ---
  // Serve them as-is on EVERY host. Without this, the platform/help rewrites
  // below would map /themes/... to /platform/themes/... and 404 the file.
  // (robots.txt / sitemap.xml are host-aware app routes at the root, and also
  // need to skip the rewrite — the extension list covers them.)
  //
  // ⚠ This is an ALLOWLIST of real asset extensions, not "any path with a
  // dot". It used to be the latter, on the assumption that app routes never
  // contain dots — which stopped being true the moment a route segment carried
  // an id with a dot in it (the notification console's `order.placed`). Such a
  // path matched here, skipped the session gate below, and reached the page
  // with no edge auth check at all. The page's own requireSectionAccess still
  // held, so nothing leaked, but a route is not supposed to depend on a single
  // layer. Keep this list to genuine file types; never widen it back to `\.\w+`.
  if (ASSET_EXTENSION.test(pathname)) {
    return NextResponse.next();
  }

  // --- Help centre: help.storemink.com -> /help/* ---
  if (isHelpHost(host) && !pathname.startsWith("/help")) {
    const url = request.nextUrl.clone();
    url.pathname = `/help${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  // --- Theme catalog: themes.storemink.com -> /themes/* ---
  // Branch before the generic platform rewrite. `themes` is reserved in store
  // signup and parseHost classifies it as platform, so it can never become a
  // merchant storefront by accident.
  if (isThemesHost(host) && !pathname.startsWith("/themes")) {
    const url = request.nextUrl.clone();
    url.pathname = `/themes${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  // --- Platform (storemink.com / app.* / localhost / preview): landing, login,
  //     signup. Rewrite all paths into the /platform/* route group so the
  //     storefront `/`, `/shop`, ... routes only ever serve store hosts. ---
  if (parseHost(host).type === "platform") {
    if (pathname.startsWith("/platform")) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = `/platform${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  // --- One address per store: {slug}.storemink.com -> verified custom domain ---
  //
  // A store with a live custom domain should have ONE address, not two that both
  // work: two hosts serving identical content split SEO signals, and a merchant
  // who has told the world about xyz.com does not want half their links on
  // xyz.storemink.com.
  //
  // 308, not 302: permanent AND method-preserving, so a POSTed form (checkout,
  // a dashboard action) survives the hop instead of being silently downgraded to
  // GET and losing its body.
  //
  // ★ THE GATE IS storeOrigin(), borrowed rather than reimplemented — see
  // lib/store/canonical.ts. That means this redirect UNDOES ITSELF exactly when
  // serving does: a lapsed Pro plan or an un-verified domain makes storeOrigin
  // return the subdomain, so the store keeps working there with no extra logic.
  // A failed lookup returns null and simply does not redirect.
  //
  // Applies to /dashboard and /pos too, deliberately (the merchant asked for one
  // address). ⚠ POS device + operator cookies are host-only and SameSite=Strict
  // by design, so every paired till must be re-authorised once after a domain
  // goes live — there is no way to carry a host-scoped credential across origins.
  const storeHost = parseHost(host);
  // `*.localhost` is a store subdomain to parseHost, but redirecting local dev to
  // a production custom domain would make that store impossible to work on.
  const isLocal = (host ?? "").split(":")[0].endsWith(".localhost");
  if (storeHost.type === "store-subdomain" && !isLocal) {
    const canonical = await canonicalHostForSlug(storeHost.slug);
    if (canonical) {
      const url = request.nextUrl.clone();
      url.host = canonical;
      url.port = "";
      url.protocol = "https:";
      const res = NextResponse.redirect(url, 308);
      // ★★ MUST NOT BE CACHED, and this is not a micro-optimisation — it is what
      // keeps the auto-revert safety net working. A 308 is heuristically
      // cacheable, and browsers cache it INDEFINITELY: without this header, a
      // merchant whose domain later breaks would have the dead redirect pinned in
      // their own browser, so reverting `custom_domain_verified` would restore
      // the subdomain for the whole internet EXCEPT the one person who needs it.
      // The status stays 308 so search engines still consolidate signals onto the
      // custom domain; only client caching is suppressed.
      res.headers.set("cache-control", "no-store");
      return res;
    }
  }

  // --- Store hosts ({slug}.storemink.com / custom domains) ---
  // Only the dashboard, auth, and POS routes need the session gate; the
  // storefront stays anonymous + cache-friendly (no per-request auth check).
  if (
    !pathname.startsWith("/dashboard") &&
    !pathname.startsWith("/auth") &&
    !pathname.startsWith("/pos")
  ) {
    // Surface the builder's ?preview=1 to the storefront LAYOUT as a header.
    // The layout renders the header and footer, and needs to know whether to
    // show the merchant their unpublished chrome — but a layout cannot read
    // searchParams at all (Next 16: "Layouts do not rerender on navigation, so
    // they cannot access search params"), and only pages get the prop. A
    // request header is the one channel that reaches both.
    //
    // This is a HINT, not authorisation: getDraftChromeForPreview still runs
    // the same getManagerUserId("builder") gate as the page-draft loader, so
    // anyone can set this header and still see only published content.
    if (request.nextUrl.searchParams.get("preview") === "1") {
      const headers = new Headers(request.headers);
      headers.set("x-sm-preview", "1");
      return NextResponse.next({ request: { headers } });
    }
    return NextResponse.next();
  }

  try {
    // Verify the Firebase session cookie (Node runtime — see the file-level note
    // in lib/auth/session-cookie.ts). role / force_password_reset ride in the
    // cookie's custom claims, so gating needs NO DB query.
    const session = request.cookies.get(SESSION_COOKIE)?.value;
    const user = await verifySessionCookie(session);

    const redirectTo = (path: string) => {
      const url = request.nextUrl.clone();
      url.pathname = path;
      return NextResponse.redirect(url);
    };

    // --- POS gate: /pos requires a Firebase session (owner/admin), a paired
    //     device, or an active operator. Fine-grained checks (Pro + pos.enabled,
    //     operator resolution, device revocation) live in the /pos layout. The
    //     signature-only verify here is cheap and DB-free; it returns null (→
    //     login) when POS_SESSION_SECRET is unset, never 500s. ---
    if (pathname.startsWith("/pos")) {
      // Public POS entry points — reachable with NO session, device or operator.
      //   /pos/login    — the sign-in / authorize-device screen.
      //   /pos/register — invited staff completing setup from their email link,
      //                   typically on their own phone. The emailed TOKEN is the
      //                   authorization and is validated server-side by
      //                   getInviteInfo; requiring a credential here would make
      //                   the invitation impossible to accept.
      //   /pos/reset    — same reasoning for the forgot-PIN/password link: a
      //                   locked-out cashier has no credential by definition.
      if (
        POS_PUBLIC_PATHS.some(
          (p) => pathname === p || pathname.startsWith(`${p}/`),
        )
      ) {
        return NextResponse.next();
      }
      const hasDevice = !!verifyDeviceToken(
        request.cookies.get(POS_DEVICE_COOKIE)?.value,
      );
      const hasOperator = !!verifyOperatorToken(
        request.cookies.get(POS_OPERATOR_COOKIE)?.value,
      );
      if (!user && !hasDevice && !hasOperator) {
        return redirectTo("/pos/login");
      }
      return NextResponse.next();
    }

    // --- Gate 1: Auth check for /dashboard routes ---
    if (pathname.startsWith("/dashboard")) {
      if (!user) {
        // ALWAYS the admin login. A POS cookie is not an identity, and it must
        // never decide where a signed-out human is sent.
        //
        // This used to check for a pos_device/pos_operator cookie and redirect
        // to /pos instead — "this browser is a till, so send it to the till".
        // It locked OWNERS out of their own dashboard, and by construction only
        // owners: authorizeThisDevice is superadmin-only, so the owner's laptop
        // is the one browser that can be both an authorised till AND an admin
        // session. pos_device lasts 90 days, sm_session 14 — so two weeks after
        // authorising a device, the owner opening /dashboard was bounced to a
        // PIN pad they may not even have a PIN for, with no way back.
        //
        // Nothing is lost by dropping it: POS staff have Firebase accounts, so
        // they arrive here WITH a user and the role check below sends them to
        // /pos correctly. Anyone genuinely POS-only just sees a login page,
        // which is the honest answer to "you need an admin account for this".
        return redirectTo("/auth/login");
      }

      // POS staff (cashier/manager) have Firebase accounts but are POS-only —
      // their role claim keeps them out of the dashboard entirely.
      if (user.claims.role === "cashier" || user.claims.role === "manager") {
        return redirectTo("/pos");
      }

      // --- Gate 2: Force password reset ---
      if (user.claims.forcePasswordReset)
        return redirectTo("/auth/set-password");

      // --- Gate 3: Role-based access for restricted dashboard routes ---
      if (
        (pathname.startsWith("/dashboard/users") ||
          pathname.startsWith("/dashboard/media")) &&
        user.claims.role !== "superadmin"
      ) {
        return redirectTo("/dashboard");
      }
    }

    // --- Gate for the "authenticated, but not yet allowed onward" screens ---
    // /auth/set-password  — a forced password reset (claim-driven, above).
    // /auth/policy-update — a policy published at a new version since this
    //                       person last agreed. Which documents are outstanding
    //                       needs a DB query, so the REDIRECT to here lives in
    //                       the dashboard layout; the proxy only enforces that
    //                       you can't reach the screen signed out.
    if (
      (pathname === "/auth/set-password" ||
        pathname === "/auth/policy-update") &&
      !user
    ) {
      return redirectTo("/auth/login");
    }

    // --- Redirect authenticated users away from login page ---
    if (pathname === "/auth/login" && user) {
      return redirectTo(
        user.claims.forcePasswordReset ? "/auth/set-password" : "/dashboard",
      );
    }

    return NextResponse.next();
  } catch (error: unknown) {
    logError("proxy: middleware exception", error, { path: pathname, host });
    return new NextResponse(
      JSON.stringify({ error: "Internal Server Error" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

export const config = {
  // Run on everything except Next internals, static files, and API routes.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
