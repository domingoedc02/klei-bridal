/**
 * Next.js boot hook (runs once per server start, before the first request).
 *
 * Imports src/config/env.ts so its Zod schema runs AT BOOT. Next only logs an
 * error thrown here and keeps serving, so on the Node runtime we exit
 * non-zero: a container with a required variable withheld must crash (and
 * fail Dokploy's healthcheck), not serve static pages half-configured
 * (KBS-7 AC4, KBS-6). The edge runtime (middleware) has no process.exit.
 */
export async function register() {
  try {
    await import("@/config/env");
    if (process.env.NEXT_RUNTIME === "nodejs") {
      const { startImageWorker } = await import("@/server/worker/imageWorker");
      startImageWorker();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (!("EdgeRuntime" in globalThis)) process.exit(1);
    throw error;
  }
}
