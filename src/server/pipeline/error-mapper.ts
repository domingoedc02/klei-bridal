import type { ErrorEnvelope } from "../../shared/schemas/errorEnvelope";
import { logger } from "../observability/logger";
import { captureError } from "../observability/sentry";
import { PipelineError, SilentlyDropped } from "./errors";

/** Where full error detail goes — never to the client (spec/api → Errors). */
export type Reporter = (error: unknown, context: { requestId: string }) => void;

/** Scrubbed structured log line + Sentry (a no-op without SENTRY_DSN). */
export const defaultReporter: Reporter = (error, { requestId }) => {
  logger.error({ request_id: requestId, err: error }, "request_failed");
  captureError(error, { requestId });
};

/** Seconds a statement timeout asks the client to wait. */
export const STATEMENT_TIMEOUT_RETRY_AFTER_SEC = 5;

/** Postgres SQLSTATEs with a client-meaningful status; every other one is a 500. */
const postgresStates: Record<string, { status: number; code: string; message: string }> = {
  "23505": { status: 409, code: "CONFLICT", message: "This conflicts with an existing record." },
  "23503": {
    status: 409,
    code: "CONFLICT",
    message: "This refers to a record that does not exist.",
  },
  "22P02": { status: 400, code: "BAD_REQUEST", message: "A value in the request is malformed." },
  "57014": {
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    message: "This took too long. Please try again shortly.",
  },
};

function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

function envelope(status: number, body: ErrorEnvelope["error"], retryAfterSec?: number): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (retryAfterSec !== undefined) headers.set("retry-after", String(Math.ceil(retryAfterSec)));
  return new Response(JSON.stringify({ error: body }), { status, headers });
}

/**
 * Step 11: every failure becomes ONE envelope. The body is built only from
 * fixed strings, the error code and the request id — never `error.message`
 * of an unknown error, so a stack, SQL text, file path, token or PII cannot
 * reach the client. Anything unmapped, and every 503, is reported in full.
 */
export function mapError(error: unknown, requestId: string, report: Reporter): Response {
  if (error instanceof SilentlyDropped) return new Response(null, { status: 204 });

  if (error instanceof PipelineError) {
    if (error.status >= 500) report(error, { requestId });
    return envelope(
      error.status,
      {
        code: error.code,
        message: error.message,
        request_id: requestId,
        ...(error.status === 422 && error.fields ? { fields: error.fields } : {}),
      },
      error.retryAfterSec,
    );
  }

  const state = sqlState(error);
  const mapped = state ? postgresStates[state] : undefined;
  if (mapped) {
    if (mapped.status >= 500) report(error, { requestId });
    return envelope(
      mapped.status,
      { code: mapped.code, message: mapped.message, request_id: requestId },
      mapped.status === 503 ? STATEMENT_TIMEOUT_RETRY_AFTER_SEC : undefined,
    );
  }

  report(error, { requestId });
  return envelope(500, {
    code: "INTERNAL_ERROR",
    message: "Something went wrong.",
    request_id: requestId,
  });
}
