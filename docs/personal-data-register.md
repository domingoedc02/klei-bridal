# Personal-data register

KBS-30. Owner: studio (controller). Notice version: see `src/shared/privacy.ts`.
Retention for every field below: **indefinite (client decision, 2026-10-08) — automated anonymisation available but disabled** (`settings.retention_enabled=false`).
Legal basis for all rows: consent, given by ticking the box on the enquiry form (`enquiries.consent_given_at`, `consent_notice_version`).
Storage: Hostinger VPS, Singapore (`decision/data-residency`). Access: any staff account (single permission level), every view audited (`audit_log`, `enquiry.view`).

| Field (`enquiries`) | Category | Purpose | Erased by erasure/retention? |
|---|---|---|---|
| `first_name`, `last_name` | identity | address her in the reply | yes |
| `contact_number` | contact | studio may call/chat | yes |
| `email` | contact | send confirmation, reply | yes |
| `message` | free text (may hold anything she types) | context for the reply | yes |
| `wedding_date` | event date | lead-time band, scheduling | no — kept, not identifying alone |
| `enquiry_gowns` / gown ids | interest | which gowns she asked about | no — kept for interest counts |
| `source` | acquisition | which channel works | no — kept, not identifying |
| `utm_source`, `utm_medium`, `utm_campaign`, `referrer_host` | acquisition detail | which campaign works | yes (in `ENQUIRY_PII_COLUMNS`) |
| `chat_channel_chosen` | preference | which chat app she tapped | no |
| `consent_given_at`, `consent_notice_version` | consent record | prove what she agreed to and when | no — evidence of consent |
| `token_hash`, `reference` | access key / reference | confirmation link, quoting in requests | no — hash only |

Erasure nulls exactly `ENQUIRY_PII_COLUMNS` in `src/server/services/enquiry-erasure.ts` (one list, shared by the manual admin action and the disabled retention job). Rows are never deleted, so monthly counts hold. The `audit_log` is never altered.

## Other places her data can sit (out of reach of the erasure action)

Erasure only touches the `enquiries` row. These need separate handling when a request arrives:

| Where | What | Handling |
|---|---|---|
| `audit_log.ip` | IP of the staff member who acted, never the bride's. `detail` holds ids only. | Append-only by design; contains no bride data. |
| Valkey | Rate-limit counters keyed by the visitor's IP; expire by TTL. | Self-clearing; no action. |
| Studio mailbox (`STUDIO_ENQUIRY_EMAIL`) | The enquiry email contains name, number, email, message. | Studio must delete the message by hand. |
| Mail provider (Resend) log | Recipient address and delivery metadata of the bride's confirmation. | Subject to provider retention; delete in the provider dashboard on request. |
| Backups | Full DB copies taken before erasure still hold the data. | Rolls off with the backup retention window; a restore must re-run erasures from `audit_log` (`enquiry.erase`). |
| Sentry/GlitchTip | Scrubbed error events (`src/server/observability/scrub.ts`); PII should not appear. | Search by reference if a request arrives. |
