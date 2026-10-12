import { createHmac, timingSafeEqual } from "node:crypto";
import type Redis from "iovalkey";
import { dispatchAlert, type Alert } from "../observability/alerts";
import { logger } from "../observability/logger";

/**
 * Resend delivery events (KBS-33-2). Resend signs with Svix: HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}`, key = base64 after `whsec_`,
 * header `svix-signature` = space-separated `v1,<base64>` entries.
 */
export const TOLERANCE_SEC = 5 * 60;

export function verifySignature(
  secret: string,
  headers: Headers,
  rawBody: string,
  nowMs: number,
): "ok" | "missing_headers" | "stale_timestamp" | "bad_signature" {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return "missing_headers";
  const ts = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_SEC) {
    return "stale_timestamp";
  }
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const entry of signatures.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return "ok";
  }
  return "bad_signature";
}

export interface MailEvent {
  type: string;
  data?: { email_id?: string; to?: string[]; bounce?: { type?: string; subType?: string } };
}

export interface MailCounts {
  failed24h: number;
  failed7d: number;
  sent7d: number;
}

/** Rolling-window counters for mail NOT sent to the studio inbox (brides, staff resets). */
export interface MailStats {
  /** `id` is the svix-id, so a provider retry is counted once. */
  record(kind: "sent" | "failed", id: string, atMs: number): Promise<MailCounts>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function createValkeyMailStats(client: Redis): MailStats {
  return {
    async record(kind, id, atMs) {
      const key = `mail:${kind}`;
      const replies = await client
        .multi()
        .zadd(key, atMs, id)
        .zremrangebyscore("mail:sent", "-inf", atMs - WEEK_MS)
        .zremrangebyscore("mail:failed", "-inf", atMs - WEEK_MS)
        .pexpire(key, WEEK_MS)
        .zcount("mail:failed", atMs - DAY_MS, "+inf")
        .zcount("mail:failed", atMs - WEEK_MS, "+inf")
        .zcount("mail:sent", atMs - WEEK_MS, "+inf")
        .exec();
      const failure = replies?.find(([error]) => error)?.[0];
      if (!replies || failure) throw failure ?? new Error("valkey: empty MULTI reply");
      const n = (i: number) => Number(replies[i]?.[1]);
      return { failed24h: n(4), failed7d: n(5), sent7d: n(6) };
    },
  };
}

export const RATE_THRESHOLD = 0.05;
export const BURST_THRESHOLD = 3;

export interface HandleDeps {
  studio: string[];
  alertInbox: string | undefined;
  stats: MailStats;
  alert?: (alert: Alert) => Promise<boolean>;
  now?: () => number;
}

/** Classify one verified event and alert. Never logs or alerts a recipient address. */
export async function handleMailEvent(event: MailEvent, eventId: string, deps: HandleDeps) {
  const alert = deps.alert ?? dispatchAlert;
  const now = (deps.now ?? Date.now)();
  const failed = event.type === "email.bounced" || event.type === "email.complained";
  if (!failed && event.type !== "email.sent") return;

  const to = (event.data?.to ?? []).map((v) => v.trim().toLowerCase());
  const studio = new Set(deps.studio.map((v) => v.trim().toLowerCase()));
  const kind = event.type.slice("email.".length);
  const bounce = [event.data?.bounce?.type, event.data?.bounce?.subType].filter(Boolean).join("/");
  const ref = `Resend email id: ${event.data?.email_id ?? "unknown"}`;

  if (to.some((v) => studio.has(v))) {
    if (!failed) return;
    // Every enquiry from now on arrives nowhere: first occurrence, no threshold.
    await alert({
      key: "mail.studio_bounce",
      severity: "critical",
      summary: `Studio enquiry inbox ${kind} — enquiries are not arriving`,
      detail: [
        `A message to STUDIO_ENQUIRY_EMAIL was ${kind}${bounce ? ` (${bounce})` : ""}.`,
        "Every enquiry email from now on may be lost. Enquiries are still saved in the admin.",
        ref,
      ],
    });
    return;
  }
  if (deps.alertInbox && to.includes(deps.alertInbox.toLowerCase())) {
    // Alerts about alerts would go to the same dead inbox; Sentry and the log are the channel.
    if (failed) logger.error({ event: "alert_inbox_bounced", kind }, "alert_inbox_bounced");
    return;
  }

  const counts = await deps.stats.record(failed ? "failed" : "sent", eventId, now);
  if (!failed) return;
  // No sent events (not registered) reads as 100%: fail loud, not silent.
  const rate = counts.sent7d > 0 ? counts.failed7d / counts.sent7d : 1;
  logger.warn({ event: "mail_delivery_failed", kind, ...counts }, "mail_delivery_failed");
  if (rate <= RATE_THRESHOLD && counts.failed24h < BURST_THRESHOLD) return;
  await alert({
    key: "mail.bride_bounce_rate",
    severity: "warning",
    summary: "Bride email bounce rate over threshold",
    detail: [
      `Last 7 days: ${counts.failed7d} bounced/complained of ${counts.sent7d} sent (${(rate * 100).toFixed(1)}%; alert above ${RATE_THRESHOLD * 100}%).`,
      `Last 24 hours: ${counts.failed24h} (alert at ${BURST_THRESHOLD}).`,
      "Check sending-domain SPF/DKIM/DMARC and Resend's suppression list.",
    ],
  });
}
