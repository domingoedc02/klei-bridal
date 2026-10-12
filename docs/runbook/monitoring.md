# Monitoring & alerts runbook

Owner: devops. Written for `KBS-33`. Every alert goes to **one inbox: `ALERT_EMAIL`**, the named technical contact. It is never `STUDIO_ENQUIRY_EMAIL`; the app refuses to boot if it is. One inbox means an incident is one place to look, not four dashboards.

Who executes: the client holds sole Dokploy/Hostinger access (`decision/client-ops-posture`), so the client runs the panel steps below. Devops writes them.

## 1. Where things live in the code

| Concern | File |
|---|---|
| The one Sentry init | `src/server/observability/sentry.ts` (`initSentry`, called from `instrumentation.ts`) |
| Redaction (`beforeSend`, `beforeSendTransaction`, `beforeBreadcrumb`) | `src/server/observability/scrub.ts`. Add new rules here. Never add a second `Sentry.init` |
| Structured logs (pino, JSON to stdout) | `src/server/observability/logger.ts`. Same scrubber as Sentry |
| In-app alert dispatch (email to `ALERT_EMAIL`) | `src/server/observability/alerts.ts` (`dispatchAlert`) |
| Request errors | `withPipeline`'s default reporter (`src/server/pipeline/error-mapper.ts`) logs and captures. `onRequestError` in `instrumentation.ts` covers server components |

**What never leaves the box:** request bodies, cookies (`kbs_session`, `kbs_csrf`), query strings, the Sentry user block (IP), `/e/<token>` short-link tokens, `?token=` reset tokens, `Bearer`/`re_…` mail keys, email addresses, and keys named `password`, `email`, `contact_number`, `phone`, `message`, `first_name`, `last_name`, `secret`, `api_key`, `token`.

## 2. Logs

- Read in **Dokploy → kbs-web → Logs**. One JSON object per line: `level`, `time`, `service`, `msg`, plus fields such as `request_id`, `err`, `event`.
- Find one failed request: search for the `request_id` the bride or staff member saw in the error message.
- CSP report-only violations: search `csp_violation` (from `KBS-28`). Only counts are logged, never the report body.
- No log aggregation in release 1. Retention is whatever Dokploy keeps.

## 3. Sentry: one-time setup (client executes)

1. Create a Sentry account on the free tier and a project of platform **Next.js**, named `kbs-web`.
2. Copy the project's **DSN** from Settings → Client Keys.
3. In **Dokploy → kbs-web → Environment**, set:
   - `SENTRY_DSN=<the DSN>`
   - `SENTRY_ENVIRONMENT=production`
4. Redeploy. With no DSN set, Sentry is off. That is the expected state locally and in CI.
5. **Alert rule: new error types, not every occurrence.** Go to Alerts → Create Alert → Issues. Condition: *"A new issue is created"*. Filter: `environment = production`. Action: *"Send a notification to"* → **Member** → the account whose email is `ALERT_EMAIL`. Delete Sentry's default "every event" rule if one exists.
6. In Settings → Security & Privacy, enable **Data Scrubber** and **Use Default Scrubbers**. Add `kbs_session`, `kbs_csrf` and `token` to *Additional Sensitive Fields*. This is a second line of defence. The app already scrubs before sending.

### Verify (pass/fail)

1. In the Sentry project, open **Settings → Alerts** and send a test notification for the "new issue" rule.
2. **Pass:** the email reaches `ALERT_EMAIL` within five minutes. **Fail:** no email arrives. Check the rule's `environment` filter and the member's address.
3. After the first real production error, open the event and confirm there is no `cookie`, request body, `/e/` token or email address in it. The app-side proof is `tests/unit/observability/observability.test.ts`.

## 4. Host monitors

Disk headroom, uptime with TLS expiry, Docker build-cache prune, encode-queue depth: see `KBS-33-3`. This section is to be filled in there.

## 5. Mail delivery alerts

Code: `app/api/webhooks/mail/route.ts` (route, through `withPipeline`) and
`src/server/mail/webhook.ts` (signature check, classification, counters). Alerts go out through
`dispatchAlert` to `ALERT_EMAIL` like every other alert.

**How a request is handled**

1. The route reads the raw body and verifies Resend's Svix signature *before* parsing anything.
   The signature is HMAC-SHA256 over `svix-id.svix-timestamp.body`, keyed with the base64 part of
   `MAIL_WEBHOOK_SIGNING_SECRET` after `whsec_`. The comparison is constant-time, and the
   timestamp must be within ±5 min.
2. Bad, missing or stale signature: `401`, nothing counted, nothing alerted. Log line
   `mail_webhook_rejected` with `reason`.
3. `MAIL_WEBHOOK_SIGNING_SECRET` unset: `503`, plus log `mail_webhook_unconfigured` and a Sentry
   event. A monitor that cannot verify must be loud.
4. Valid event:

| Event recipient | `email.bounced` / `email.complained` | `email.sent` |
|---|---|---|
| Any `STUDIO_ENQUIRY_EMAIL` address | **Critical alert `mail.studio_bounce` on the first occurrence.** No threshold. | ignored |
| `ALERT_EMAIL` | Log `alert_inbox_bounced` only, because an alert would go to the same dead inbox. Sentry is the channel. | ignored |
| Anyone else (brides, staff resets) | Counted. **Warning alert `mail.bride_bounce_rate`** when the 7-day rate is **> 5%**, or **≥ 3** in 24 h. | Counted (the denominator) |

Alerts carry counts, the rate and the Resend email id, **never an address**. Repeats of one alert
key are suppressed for 15 minutes.

Counters live in Valkey sorted sets `mail:sent` and `mail:failed`, keyed by `svix-id` so a
provider retry counts once. Each set is trimmed to 7 days.

A Valkey restart empties the counters. The rate then restarts from zero; the studio-bounce alert
is unaffected.

**Client setup (one time, with `docs/runbook/dns-records.md` §5)**

1. Set `MAIL_WEBHOOK_SIGNING_SECRET` in Dokploy to the `whsec_…` value Resend shows for the
   endpoint, then redeploy.
2. Register `https://<domain>/api/webhooks/mail` in Resend → Webhooks with **exactly** these
   events: `email.sent`, `email.bounced`, `email.complained`.
   - Without `email.sent` the denominator is zero, so every bride bounce reads as 100% and alerts.
     That is deliberate (fail loud), but noisy.

**Verify (pass/fail)**

1. In Resend, send a test `email.bounced` event. **Pass:** Resend shows `2xx`, and the Dokploy log
   has a `mail_delivery_failed` line with counts. **Fail:** `401`. Check that the secret was copied
   whole, including `whsec_`, and that the server clock is in sync.
2. From a laptop: `curl -i -X POST https://<domain>/api/webhooks/mail -H 'content-type: application/json' -d '{}'`.
   **Pass:** `401` and a `mail_webhook_rejected` log line with `reason: "missing_headers"`.
3. Studio inbox path: temporarily add a known-bouncing address (e.g. `bounced@resend.dev`) to
   `STUDIO_ENQUIRY_EMAIL`, submit a test enquiry, then remove it.
   **Pass:** `[KBS CRITICAL] Studio enquiry inbox bounced` reaches `ALERT_EMAIL` within minutes.

**When it fires**

- `mail.studio_bounce`: enquiries are no longer reaching the studio inbox. They are still saved in
  the admin, so read them there. Fix the mailbox (full, deleted, or the domain lapsed), then check
  Resend's suppression list and remove the studio address from it.
- `mail.bride_bounce_rate`: check SPF/DKIM/DMARC (`dns-records.md`) and Resend's domain status. A
  spike of complaints means mail is landing as spam.
