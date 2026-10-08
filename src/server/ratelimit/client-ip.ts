/**
 * The client address a limit is keyed on. In production the app sits
 * behind exactly one reverse proxy on the same box (spec/architecture),
 * which APPENDS the peer address to `X-Forwarded-For`. Only that last
 * entry is trustworthy — everything to its left came from the client and
 * can be forged to dodge a per-IP limit. `X-Real-IP` wins when the proxy
 * sets it, because the proxy overwrites it rather than appending.
 */
export function clientIp(headers: Headers): string {
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").at(-1)?.trim();
  return last || "unknown";
}
