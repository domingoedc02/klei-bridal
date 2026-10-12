import type { NextRequest } from "next/server";
import { env } from "@/config/env";
import {
  createValkeyMailStats,
  handleMailEvent,
  verifySignature,
  type MailEvent,
  type MailStats,
} from "@/server/mail/webhook";
import { logger } from "@/server/observability/logger";
import { PipelineError, requestIdOf, withPipeline } from "@/server/pipeline";
import { budgets } from "@/server/ratelimit/budgets";

let stats: MailStats | undefined;
async function defaultStats(): Promise<MailStats> {
  const { getValkeyClient } = await import("@/server/ratelimit");
  return (stats ??= createValkeyMailStats(getValkeyClient()));
}

/** Resend delivery events (KBS-33-2). Authenticated by signature, verified on the raw body BEFORE parsing. */
export async function mailWebhookHandler(
  request: NextRequest,
  deps: { stats?: MailStats; now?: () => number } = {},
): Promise<Response> {
  const secret = env.MAIL_WEBHOOK_SIGNING_SECRET;
  const requestId = requestIdOf(request.headers);
  if (!secret) {
    logger.error(
      { event: "mail_webhook_unconfigured", request_id: requestId },
      "mail_webhook_unconfigured",
    );
    throw new PipelineError(503, "SERVICE_UNAVAILABLE", "Not configured.", {
      detail: "MAIL_WEBHOOK_SIGNING_SECRET is not set",
    });
  }
  const raw = await request.text();
  const verdict = verifySignature(secret, request.headers, raw, (deps.now ?? Date.now)());
  if (verdict !== "ok") {
    logger.warn(
      { event: "mail_webhook_rejected", reason: verdict, request_id: requestId },
      "mail_webhook_rejected",
    );
    throw new PipelineError(401, "UNAUTHENTICATED", "Invalid signature.");
  }

  let event: MailEvent;
  try {
    event = JSON.parse(raw) as MailEvent;
  } catch {
    throw new PipelineError(400, "BAD_REQUEST", "Malformed body.");
  }
  if (!event || typeof event.type !== "string")
    throw new PipelineError(400, "BAD_REQUEST", "Malformed body.");

  await handleMailEvent(event, request.headers.get("svix-id")!, {
    studio: env.STUDIO_ENQUIRY_EMAIL.split(","),
    alertInbox: env.ALERT_EMAIL,
    stats: deps.stats ?? (await defaultStats()),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return new Response(null, { status: 204 });
}

export const POST = withPipeline((request: NextRequest) => mailWebhookHandler(request), {
  auth: "public",
  // A server-to-server POST with no browser and no cookie: the signature authenticates
  // the sender, which is strictly stronger than a CSRF token (KBS-33 Security).
  csrf: false,
  rateLimit: budgets.mailWebhook,
});
