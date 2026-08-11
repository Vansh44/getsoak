/** Cross-subdomain Firebase session cookie. Kept in a dependency-free module
 * so Server Components can inspect its presence without importing firebase-admin. */
export const SESSION_COOKIE = "sm_session";
