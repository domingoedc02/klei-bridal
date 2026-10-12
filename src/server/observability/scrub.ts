/**
 * Egress scrubbing for everything that leaves the process: Sentry events and
 * log lines (KBS-33, spec/architecture integrations §8). Pure: no env, no SDK
 * import, so it is unit-tested directly.
 *
 * `scrubEvent` IS Sentry's `beforeSend`, wired in ./sentry.ts — the ONE
 * Sentry.init in this codebase. New redaction rules go here, never in a
 * second init (KBS-91-2 adds its reset-token cases to STRING_RULES /
 * SENSITIVE_KEY).
 */

export const REDACTED = "[redacted]";

/** String rules, each global. */
const STRING_RULES: Array<[RegExp, string]> = [
  // The enquiry short link: the token IS the credential for the enquiry view.
  [/\/e\/[A-Za-z0-9_-]+/g, `/e/${REDACTED}`],
  // Token-ish query/form parameters (reset links carry `?token=`).
  [/([?&;\s](?:token|reset_token)=)[^&#\s"']+/gi, `$1${REDACTED}`],
  // Our cookies by name, wherever a header dump or message carries them.
  [/((?:kbs_session|kbs_csrf)=)[^;\s"']+/g, `$1${REDACTED}`],
  // Bearer credentials (the mail provider key travels as one).
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  // Resend keys pasted into a message or a thrown error.
  [/\bre_[A-Za-z0-9_]{8,}\b/g, REDACTED],
  // Email addresses: a bride's address in an error message or log is PII.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

export function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of STRING_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** Keys whose values are dropped outright, at any depth. */
const SENSITIVE_KEY =
  /^(cookie|cookies|set-cookie|authorization|password|new_?password|current_?password|token|raw_?token|secret|api_?key|email|contact_?number|phone|message|first_?name|last_?name)$/i;

const MAX_DEPTH = 12;

/** Non-mutating deep scrub. Errors become plain {type, message, stack}. */
export function scrubValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (!value || typeof value !== "object") return value;
  if (depth > MAX_DEPTH || seen.has(value)) return "[truncated]";
  seen.add(value);
  if (value instanceof Error) {
    return {
      type: value.name,
      message: scrubString(value.message),
      ...(value.stack ? { stack: scrubString(value.stack) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubValue(field, depth + 1, seen);
  }
  return out;
}

type ScrubbableEvent = { request?: object; user?: unknown; message?: unknown };

/**
 * Sentry `beforeSend` / `beforeSendTransaction`. Request bodies go entirely
 * (enquiry and login bodies are bride PII and passwords), cookies and the
 * query string go, the user block goes (IP address), then every remaining
 * string is rule-scrubbed and sensitive keys dropped.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const copy = { ...event };
  if (copy.request) {
    const request: Record<string, unknown> = { ...copy.request };
    delete request.data;
    delete request.cookies;
    delete request.query_string;
    copy.request = request;
  }
  delete copy.user;
  const { message, ...rest } = copy;
  const out = scrubValue(rest) as T;
  // Sentry's own top-level message is diagnosis, not a bride's enquiry text: scrub, don't drop.
  if (typeof message === "string") out.message = scrubString(message);
  return out;
}

/** Sentry `beforeBreadcrumb`: breadcrumbs carry request URLs and console lines. */
export function scrubBreadcrumb<T>(breadcrumb: T): T {
  return scrubValue(breadcrumb) as T;
}
