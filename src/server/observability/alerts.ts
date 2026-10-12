import "server-only";
import { env } from "@/config/env";
import { sendTransactionalEmail } from "@/server/mail/send";
import { logger } from "./logger";
import { scrubString } from "./scrub";

/**
 * The single alert path (KBS-33): mail-delivery events, queue health and any
 * other in-app operational signal dispatch here, to ONE inbox
 * (`ALERT_EMAIL`, a named technical contact — never STUDIO_ENQUIRY_EMAIL,
 * env.ts refuses that at boot). Sentry's own "new issue" alert rule and the
 * external uptime/disk monitors email the same address
 * (docs/runbook/monitoring.md), so an incident is one inbox, not four
 * dashboards.
 *
 * An alert names the CLASS of failure and counts — never a bride's address
 * or details. Summary and detail are scrubbed anyway.
 */
export type AlertSeverity = "critical" | "warning";

export interface Alert {
  /** Stable id for the alert class, e.g. "mail.studio_bounce". Repeats within the window are suppressed. */
  key: string;
  severity: AlertSeverity;
  summary: string;
  /** Plain-text body lines: what happened, counts, what to do. */
  detail: string[];
}

export interface AlertDeps {
  send?: typeof sendTransactionalEmail;
  now?: () => number;
  to?: string | undefined;
}

/** ponytail: in-memory, per-process repeat suppression; one container in prod, so enough. Move to Valkey if we ever scale out. */
const SUPPRESS_MS = 15 * 60 * 1000;
const lastSent = new Map<string, number>();

export function resetAlertSuppression(): void {
  lastSent.clear();
}

/** Never throws: an alert failure is logged, not propagated into the caller's request. */
export async function dispatchAlert(alert: Alert, deps: AlertDeps = {}): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const to = "to" in deps ? deps.to : env.ALERT_EMAIL;
  const summary = scrubString(alert.summary);
  const detail = alert.detail.map(scrubString);
  const log = alert.severity === "critical" ? logger.error.bind(logger) : logger.warn.bind(logger);

  const previous = lastSent.get(alert.key);
  if (previous !== undefined && now - previous < SUPPRESS_MS) {
    log({ alert: alert.key, suppressed: true }, summary);
    return false;
  }

  log({ alert: alert.key, severity: alert.severity }, summary);
  if (!to) {
    logger.error({ alert: alert.key }, "alert_undeliverable: ALERT_EMAIL is not set");
    return false;
  }

  lastSent.set(alert.key, now);
  const subject = `[KBS ${alert.severity.toUpperCase()}] ${summary}`;
  const text = [...detail, "", `Alert: ${alert.key}`, "Runbook: docs/runbook/monitoring.md"].join(
    "\n",
  );
  try {
    await (deps.send ?? sendTransactionalEmail)({
      to,
      subject,
      text,
      html: `<pre>${escapeHtml(text)}</pre>`,
    });
    return true;
  } catch (error) {
    lastSent.delete(alert.key);
    logger.error({ alert: alert.key, err: error }, "alert_send_failed");
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
