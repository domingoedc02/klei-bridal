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

Studio-address bounce and bride bounce rate: see `KBS-33-2`. This section is to be filled in there.
