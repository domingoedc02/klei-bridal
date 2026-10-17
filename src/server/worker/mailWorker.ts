import "server-only";

import { env } from "@/config/env";
import { logger } from "@/server/observability/logger";
import { captureError } from "@/server/observability/sentry";
import { processMailOutbox } from "@/server/mail/mail-outbox";

const POLL_MS = 2_000;
let started = false;

const workerFailed = (error: unknown) => {
  logger.error({ err: error }, "mail_worker_failed");
  captureError(error);
};

export function startMailWorker() {
  if (started) return;
  started = true;
  const poll = () => void processMailOutbox().catch(workerFailed);
  const timer = setInterval(poll, POLL_MS);
  timer.unref();
  poll();
}

export const mailWorkerPollMs = env.NODE_ENV === "test" ? 0 : POLL_MS;
