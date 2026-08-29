/**
 * Reject state-changing Mink requests whose browser Origin does not match the
 * public request host. Cloud Run exposes its internal host in request.url, so
 * the trusted forwarded host takes precedence just as it does in store routing.
 */
export function rejectForeignMinkOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;

  try {
    const forwardedHost = request.headers
      .get("x-forwarded-host")
      ?.split(",")[0]
      ?.trim();
    const requestHost = (
      forwardedHost ||
      request.headers.get("host")?.trim() ||
      new URL(request.url).host
    ).toLowerCase();
    if (new URL(origin).host.toLowerCase() === requestHost) return null;
  } catch {
    // Invalid origins are rejected below.
  }

  return Response.json(
    { error: "Cross-origin Mink AI requests are not allowed." },
    { status: 403 },
  );
}
