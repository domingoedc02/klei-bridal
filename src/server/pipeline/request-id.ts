/**
 * The request id, from the client only when it is a plain token: it is
 * echoed into logs and the error envelope, so a header carrying newlines,
 * markup or a megabyte must never pass through. Anything else gets a fresh
 * UUID.
 */
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export function requestIdOf(headers: Headers): string {
  const candidate = headers.get("x-request-id");
  return candidate && REQUEST_ID.test(candidate) ? candidate : crypto.randomUUID();
}
