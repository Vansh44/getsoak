import { type NextRequest, NextResponse } from "next/server";
import { parseHost, isHelpHost } from "@/lib/store/host";
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

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");

  // --- Static public assets (e.g. /themes/arcade/preview.webp, svgs) ---
  // Serve them as-is on EVERY host. Without this, the platform/help rewrites
  // below would map /themes/... to /platform/themes/... and 404 the file.
  // Anything with a file extension is a public asset (app routes never have
  // dots except robots.txt/sitemap.xml, which should also skip the rewrite —
  // they're host-aware app routes at the root).
  if (/\.[a-z0-9]+$/i.test(pathname)) {
    return NextResponse.next();
  }

  // --- Help centre: help.storemink.com -> /help/* ---
  if (isHelpHost(host) && !pathname.startsWith("/help")) {
    const url = request.nextUrl.clone();
    url.pathname = `/help${pathname === "/" ? "" : pathname}`;
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

  // --- Store hosts ({slug}.storemink.com / custom domains) ---
  // Only the dashboard, auth, and POS routes need the session gate; the
  // storefront stays anonymous + cache-friendly (no per-request auth check).
  if (
    !pathname.startsWith("/dashboard") &&
    !pathname.startsWith("/auth") &&
    !pathname.startsWith("/pos")
  ) {
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
        // A POS-only device/operator (no Firebase session) has no business in
        // the dashboard — send it to the register, not the admin login.
        const posOnly =
          verifyDeviceToken(request.cookies.get(POS_DEVICE_COOKIE)?.value) ||
          verifyOperatorToken(request.cookies.get(POS_OPERATOR_COOKIE)?.value);
        return redirectTo(posOnly ? "/pos" : "/auth/login");
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

    // --- Gate for /auth/set-password: must be authenticated ---
    if (pathname === "/auth/set-password" && !user) {
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
