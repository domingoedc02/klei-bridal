/**
 * Next.js boot hook (runs once per server start, before the first request).
 *
 * Imports src/config/env.ts so its Zod schema runs AT BOOT. Next only logs an
 * error thrown here and keeps serving, so on the Node runtime we exit
 * non-zero: a container with a required variable withheld must crash (and
 * fail Dokploy's healthcheck), not serve static pages half-configured
 * (KBS-7 AC4, KBS-6). The edge runtime (middleware) has no process.exit.
 *
 * Sentry (KBS-33-1): the one init lives in src/server/observability/sentry.ts,
 * with its redaction hook in ./scrub.ts. `onRequestError` reports errors
 * thrown by server components, route handlers and server actions.
 */
export async function register() {
  try {
    const { env } = await import("@/config/env");
    if (process.env.NEXT_RUNTIME === "nodejs") {
      const { initSentry } = await import("@/server/observability/sentry");
      initSentry(env.SENTRY_DSN, env.SENTRY_ENVIRONMENT);
      const { startImageWorker } = await import("@/server/worker/imageWorker");
      startImageWorker();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (!("EdgeRuntime" in globalThis)) process.exit(1);
    throw error;
  }
}

export async function onRequestError(...args: unknown[]) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureRequestError } = await import("@/server/observability/sentry");
  (captureRequestError as (...a: unknown[]) => void)(...args);
}
