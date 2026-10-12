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

Client executes Dokploy and external-monitor setup. Team has no VPS credentials (`decision/client-ops-posture`), so no provider-specific cron or dashboard is committed. Record every monitor's destination as `ALERT_EMAIL`, and record one successful test event before marking KBS-34 complete.

### Disk headroom: 70% warning, 80% action

1. In Dokploy server monitoring, add filesystem usage for the VPS root filesystem and the filesystem holding the `kbs-media` volume on the host. Alert at **70% used** (warning) and **80% used** (critical/action). If Dokploy cannot alert on filesystem usage, add this root cron instead:

```cron
# Asia/Manila off-peak is not required for a read-only check; run hourly.
0 * * * * /usr/local/sbin/kbs-disk-check
```

`/data/media` exists only inside the container, so the host check must not use it. On the host, find the volume path once with `docker volume inspect kbs-media --format '{{.Mountpoint}}'`. It is normally under `/var/lib/docker/volumes/`. `/usr/local/sbin/kbs-disk-check` must run `df -P / "$(docker volume inspect kbs-media --format '{{.Mountpoint}}')"`, parse the percentage column, and send a warning/critical message through the client's chosen monitor to `ALERT_EMAIL`. Do not put mail credentials in the script or repository. Include mount, percentage, available bytes and the runbook URL. Alert only on threshold crossing or while an incident is open; do not mail every hourly sample. **If `docker volume inspect` or `df` exits non-zero, send a critical alert** ("disk check failed") rather than exiting silently. A broken check must not look like a healthy disk.

**Pass:** a temporary test threshold or monitor test sends a warning to `ALERT_EMAIL`, then a critical test at 80%. **Fail:** no message in five minutes; check monitor ownership and destination. Restore real thresholds after test.

### External uptime and TLS

Create one external monitor in UptimeRobot, Better Stack or equivalent:

| Check | Value |
|---|---|
| URL 1 | `https://<production-domain>/` |
| URL 2 | `https://<production-domain>/gowns/<known-published-slug>` |
| Interval | **1–5 minutes**; use 5 minutes on free tier |
| Expected status | `200` |
| TLS expiry | **Enabled**; alert before expiry (30 days recommended) |
| Notifications | `ALERT_EMAIL`; SMS only if client already owns a provider |
| Never monitor | `/e/<token>` short links or `/admin/*`. A token would sit in a third party's config, and admin pages are not the public health signal |

**Pass:** both checks return 200, TLS check shows a valid certificate, and a test pause/failure reaches `ALERT_EMAIL`. **Fail:** any 4xx/5xx, timeout or certificate warning; inspect Dokploy deployment health and Traefik logs. Do not use an internal-only health check as the sole uptime monitor.

### Docker builder cache prune

Add one host cron under the client's Dokploy/Hostinger maintenance schedule. Run it weekly at **05:30 `Asia/Manila`**, just after the 23:00–05:00 deploy window (`docs/runbook/deploy.md` §6) and before studio hours, so a prune never competes with a deploy's build. Command:

```cron
# Saturday 05:30 Asia/Manila (outside the 23:00–05:00 deploy window); client must confirm host cron timezone.
30 5 * * 6 docker builder prune --filter until=168h --force >> /var/log/kbs-docker-prune.log 2>&1
```

If host timezone is not `Asia/Manila`, configure the schedule in Dokploy's timezone selector or convert 05:30 before saving (05:30 Asia/Manila = 21:30 UTC Friday). **Never use `docker system prune -a`** and never add `--volumes`: named Postgres/media volumes must survive. Keep the log for troubleshooting. Review `df -h` before and after the first run.

**Pass:** command exits 0, removes only builder cache older than 168h, and `df -h` shows reclaimed/unchanged space. **Fail:** permission error or volume warning; run it as the Docker-admin account, then verify `docker volume ls` and stop. Do not widen the prune command.

### Encode queue depth and oldest pending age

Queue state lives in Postgres table `image_jobs` (not Valkey). Add a Dokploy/DB monitor or a read-only hourly check with this query. Run it as a dedicated read-only role (`GRANT SELECT ON image_jobs` only). Keep that role's password in Dokploy's environment or the monitor's secret store, **never in this repository or in a crontab line**:

```sql
SELECT
  COUNT(*) FILTER (WHERE status IN ('pending', 'processing')) AS active_jobs,
  COUNT(*) FILTER (WHERE status = 'pending') AS pending_jobs,
  COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE status = 'pending')))::int, 0) AS oldest_pending_age_seconds
FROM image_jobs;
```

Alert thresholds: warning when `pending_jobs > 0` and `oldest_pending_age_seconds > 900` (15 minutes); critical when it exceeds **3600 seconds** (1 hour), or when active jobs grow for three consecutive samples. This matches worker stale recovery (`15 min`) and bounded concurrency (`IMAGE_WORKER_CONCURRENCY=2`). Report counts and age only; never include image paths or bride data in an alert.

**Pass:** insert a disposable pending test row in a local database (`spec/setup`), observe warning then critical thresholds, and remove it; production test must use the monitor's dry-run feature, not a real `image_jobs` row. **Fail:** no alert or a query that scans/locks rows; use the aggregate query above and a read-only DB role.

### One test record

For KBS-34 go-live report back: disk warning/critical test result, uptime/TLS test result, prune result and date, queue monitor test result, and the exact `ALERT_EMAIL` destination used. A monitor without a recorded test is configuration, not monitoring.

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
