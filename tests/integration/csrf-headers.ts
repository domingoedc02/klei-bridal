import { env } from "@/config/env";
import { CSRF_COOKIE, CSRF_HEADER, mintCsrfToken } from "@/server/pipeline/csrf";

/**
 * Headers a same-origin browser sends on a state-changing request (KBS-11-2):
 * matching double-submit cookie + header, and Origin = SITE_URL.
 * `cookie` is any extra cookie string, e.g. the session cookie.
 */
export function csrfHeaders(cookie?: string): Record<string, string> {
  const token = mintCsrfToken();
  return {
    origin: new URL(env.SITE_URL).origin,
    cookie: [cookie, `${CSRF_COOKIE}=${token}`].filter(Boolean).join("; "),
    [CSRF_HEADER]: token,
  };
}
