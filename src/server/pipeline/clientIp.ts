/**
 * Client IP, read from the `X-Forwarded-For` chain Traefik produces
 * (spec/architecture step 5: "trusted hop count fixed").
 *
 * Traefik appends the socket peer address to whatever XFF the request
 * carried, so a client-forged `X-Forwarded-For: 1.2.3.4` becomes
 * `1.2.3.4, <real client>` — the RIGHTMOST entry is the only one we can
 * trust. Counting from the right by a fixed hop count, rather than taking
 * the leftmost entry, is what stops a rate limit being bypassed by a forged
 * header. Next itself sets `x-forwarded-for ??= socket.remoteAddress`, so
 * the header is present in development too.
 */
export const TRUSTED_PROXY_HOPS = 1;

export function clientIp(request: Request, hops: number = TRUSTED_PROXY_HOPS): string {
  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // One trusted hop → the last entry; two → the one before it, and so on.
  return chain[chain.length - hops] ?? chain[0] ?? "unknown";
}
