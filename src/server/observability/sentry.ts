import * as Sentry from "@sentry/nextjs";
import { scrubBreadcrumb, scrubEvent } from "./scrub";

/**
 * THE Sentry init — the only `Sentry.init` in this codebase (KBS-33-1).
 * Called from `instrumentation.ts` on the nodejs runtime (middleware runs
 * on nodejs too, so there is no edge code to instrument).
 * Redaction is `beforeSend` → `scrubEvent` in ./scrub.ts; add rules there
 * (KBS-91-2), never a second init.
 *
 * No DSN, no Sentry: local dev, CI and tests send nothing. `SENTRY_DSN` is
 * production-only (spec/setup). No client-side init: a browser SDK would
 * need a public DSN and see every bride's form; server errors are what we
 * alert on.
 */
export function initSentry(dsn: string | undefined, environment: string | undefined): boolean {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: environment ?? "production",
    // Never attach IPs, cookies or request bodies by default; scrubEvent is the backstop.
    sendDefaultPii: false,
    // Errors only; no performance tracing on a box sized tightly (decision/vps-capacity).
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
  return true;
}

/** Report an error with a request id tag. Safe to call when Sentry is not initialised. */
export function captureError(error: unknown, context: { requestId?: string } = {}): void {
  Sentry.withScope((scope) => {
    if (context.requestId) scope.setTag("request_id", context.requestId);
    Sentry.captureException(error);
  });
}

export const captureRequestError = Sentry.captureRequestError;
