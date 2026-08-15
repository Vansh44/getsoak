import "server-only";

import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth/server-user";
import { getPlatformViewer, type PlatformViewer } from "@/app/actions/platform";

// ---------------------------------------------------------------------------
// The console's page-level gate.
//
// ★ THE LAYOUT ALREADY GATES — THIS IS NOT REDUNDANT. A Next layout and its
// pages render CONCURRENTLY: a layout `redirect()` does not abort a page that
// is already fetching, which is the same property that forces every storefront
// page to call `requireStorefrontStore()` for itself even though the
// `(storefront)` layout guards too (CODEBASE §3). These pages read every
// store on the platform under `withService`, which bypasses RLS — so the gate
// is the whole of the access control and belongs where the read is.
//
// It is one helper rather than the copied `getServerUser` + `getPlatformViewer`
// pair precisely because a gate that has to be re-typed per page is a gate the
// next page will get subtly wrong.
// ---------------------------------------------------------------------------

/**
 * The signed-in platform operator, or a redirect away from the console.
 *
 * `/dashboard/login` when nobody is signed in (they can fix that), `/dashboard`
 * when they are signed in but are not an operator — the home page renders a
 * "not authorized" explanation rather than bouncing them in a loop.
 */
export async function requireOperator(): Promise<PlatformViewer> {
  const user = await getServerUser();
  if (!user) redirect("/dashboard/login");

  const viewer = await getPlatformViewer();
  if (!viewer) redirect("/dashboard");

  return viewer;
}

/**
 * May this operator change money, plans or store existence?
 *
 * ⚠ A member is NOT redirected away from those screens — they get the
 * read-only view. Bouncing someone off a page they can partly use teaches them
 * nothing about why. The write actions gate themselves server-side regardless;
 * this only decides what the UI offers.
 */
export function canManage(viewer: PlatformViewer): boolean {
  return viewer.role === "superadmin";
}
