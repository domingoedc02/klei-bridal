# Go-live checklist — Klei Bridal Studio

Owner: devops (Kwame Asante), with project-manager owning the handover-gate items as noted.
Run this **immediately before flipping DNS to serve real traffic** (`KBS-34`). Nothing on this
list is invented — where a line depends on a fact only the client can supply, it is marked
**⚠ BLOCKED** rather than filled with a guess, per team convention
(`spec/operations`, `decision/vps-capacity`).

Companion docs: `docs/runbook/dns-records.md` (KBS-34-1) · `docs/runbook/deploy.md` (KBS-31-2).

## Who runs this

**The client retains sole Dokploy and Hostinger access** (`decision/ops-access-and-backup-deferral`) —
every gate below that needs the Dokploy UI, the VPS, or the client's own accounts (Resend,
Facebook/Instagram, the domain registrar) is **executed by the client**, with devops providing
the exact steps and reading the reported result. This is the agreed delivery model, not a
blocker to escalate past.

## Status snapshot (keep this line current)

As of this writing: `KBS-31` (pipeline) has not started, so nothing on the technical gates
below can be checked yet. `KBS-32` (restore drill) is **suspended by client decision** (see its
line below) rather than "not started" — there is nothing currently in progress to wait on
there, only a decision to revisit before go-live. This document exists so the checklist is
agreed and ready to run the moment `KBS-31` lands, not written at the last minute.

## Technical gates

- [ ] `KBS-31`'s deploy pipeline green (CI: lint, typecheck, test, e2e, Docker build-verify).
- [ ] **`KBS-31`'s deploy-twice volume check passed** — the catalogue is not re-encoded on the
      second deploy. See `docs/runbook/deploy.md` → "AC-OPS-01 procedure" for the exact steps.
      **A single deploy is not a valid test of this.**
- [ ] **`KBS-32`'s restore drill passed, with RPO and RTO actually recorded.**
      ⏸ **SUSPENDED by client decision, not an open engineering task.** The client answered,
      verbatim: *"No Backup, and this is not necessary for now."* (`decision/client-ops-posture`,
      `decision/ops-access-and-backup-deferral`). `KBS-32` remains plan-approved and in the
      backlog; **its release gate is suspended at the client's explicit instruction**, not
      quietly dropped — keeping it as a named line here, checked off only if reinstated, is
      deliberate: a studio with a live catalogue and real enquiries in December is a different
      risk position from an empty one today, and this line should be looked at again before
      go-live, not forgotten because it was unchecked in October.
      **The consequence, stated plainly and not softened by the word "suspended":** with no
      backup, the uploaded gown originals have no protection, and originals cannot be
      regenerated from anything if lost — only derivatives can be rebuilt, from originals.
      A disk failure with no backup means re-shooting the catalogue. Zero-cost mitigation
      worth the client hearing again before go-live: **keep the photographer's original files
      retained off this server** — that alone removes most of the irreversible risk regardless
      of what the client decides about `KBS-32`.
- [ ] `KBS-33`'s monitors wired and alerting to a real address, including the first-bounce
      alert on `STUDIO_ENQUIRY_EMAIL`.
      ⚠ **BLOCKED** — `ALERT_EMAIL` is not yet known, and **it must not equal
      `STUDIO_ENQUIRY_EMAIL`** (a studio-address bounce alert delivered to the bouncing
      address is circular). Owner: project-manager, with the client.
- [ ] SPF, DKIM and DMARC passing; test enquiry reaching Gmail, Outlook and Yahoo without
      landing in spam. See `docs/runbook/dns-records.md` steps 3–4.
- [ ] Mail delivery-event webhook registered with the provider and verified by a test event.
      See `docs/runbook/dns-records.md` step 5.
- [ ] Privacy policy **published** on the live domain (team drafts, client reviews —
      `decision/post-draft-revisions`; sequencing and dates owned by project-manager/
      business-researcher on `KBS-34`, not devops).
- [ ] First admin account created for a **named person** — see "First admin" below.
- [ ] One real end-to-end smoke test: submit a real enquiry, confirm it arrives in the studio
      inbox **and** in admin, and that the bride's own copy arrives.
- [ ] Both chat hand-offs tested with the **real** `MESSENGER_PAGE_HANDLE` and
      `WHATSAPP_NUMBER` — not placeholders.
      ⚠ **BLOCKED** — neither value has been supplied yet. A malformed value silently routes
      brides away from the studio at the conversion point. Owner: project-manager, with the
      client.

## Handover gates — not code, and the ones most likely to be skipped

- [ ] **UTM-tagged links handed to the studio**, and confirmation they know to use them in
      their own Facebook/Instagram posts. Owner: project-manager.
- [ ] **A named person at the studio trained on the copy-link action.** Owner: project-manager.
- [ ] **Week-1 direct-bucket sanity check scheduled** (`research/metrics` M8). Owner:
      project-manager.
- [ ] **Client acknowledgement of ongoing operational ownership, in writing** — OS and Docker
      patching, backup administration and restore competence, uptime response, disk headroom
      and TLS-renewal awareness are the client's indefinitely, not a vendor's. Owner:
      project-manager, with the client.
- [ ] **Named owner for GDPR erasure requests** at the studio. Owner: project-manager.

## Production environment variables (Dokploy UI only — never the repository)

Full table and examples in `spec/setup`. Status column reflects what devops can actually set
today versus what is still waiting on a client fact — **do not fill a ⚠ row with a guess.**

| Variable | Status | Note |
|---|---|---|
| `NODE_ENV` | ✅ | `production` |
| `DATABASE_URL` | ✅ (once Dokploy Postgres service exists) | Dokploy service name, not `localhost` |
| `REDIS_URL` | ✅ (once Dokploy Valkey service exists) | |
| `SESSION_SECRET` | ✅ procedure known | Generate fresh with `openssl rand -hex 32` at bring-up time — **never reused from any non-production environment.** Rotating it later signs out every staff member (`KBS-27`) — a deliberate, documented action. |
| `SITE_URL` / `NEXT_PUBLIC_SITE_URL` | ⚠ BLOCKED (domain registration in progress — client committed this week) | Needs the live domain — `docs/runbook/dns-records.md` |
| `MAIL_PROVIDER_API_KEY` | ⚠ BLOCKED | Production Resend key, distinct from the dev sandbox key — can be created as soon as the domain exists, does not itself wait on DNS propagation |
| `MAIL_FROM_ADDRESS` / `MAIL_SENDING_DOMAIN` | ⚠ BLOCKED (domain registration in progress) | Needs the live domain |
| `STUDIO_ENQUIRY_EMAIL` | ⚠ BLOCKED | Client fact, not yet supplied |
| `MAIL_DRY_RUN` | ✅ | `false` in production, always |
| `MAIL_WEBHOOK_SIGNING_SECRET` | ✅ procedure known | Generate and set **before** webhook registration — `docs/runbook/dns-records.md` step 5 |
| `ALERT_EMAIL` | ⚠ BLOCKED | Must differ from `STUDIO_ENQUIRY_EMAIL` — see Technical gates above |
| `IMAGE_ORIGINALS_PATH` / `IMAGE_CACHE_PATH` | ✅ | `/data/media/originals`, `/data/media/derivatives` — fixed values, the `kbs-media` volume mount from `docs/runbook/deploy.md` |
| `STUDIO_TIMEZONE` | ⚠ BLOCKED | Seeded `Asia/Manila` everywhere as an **unconfirmed assumption** — moves together with the deploy window and the lead-time band calculation if the client answers differently (`decision/vps-capacity`, `KBS-31`) |
| `DEFAULT_CURRENCY` | ✅ | `PHP`, confirmed |
| `MESSENGER_PAGE_HANDLE` / `WHATSAPP_NUMBER` | ⚠ BLOCKED | Bootstrap-only values (seed `settings`, then client-editable) — real values not yet supplied |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` | ✅ procedure known | Production Sentry project, `SENTRY_ENVIRONMENT=production` |

## First admin

```
# Run ONCE against production, after the schema is migrated:
SEED_ADMIN_EMAIL=<named person's real email> \
SEED_ADMIN_PASSWORD=<a real, freshly chosen password — never a default> \
pnpm db:seed:admin
```

- The account belongs to a **named individual**, never a shared or default credential
  (`KBS-24`'s named-accounts decision would be undermined on day one by a shared bootstrap
  account).
- `SEED_ADMIN_PASSWORD` is read once at seed time and never again — rotate it through the
  app's own staff-account flow afterward if it needs to change.

## Reference

`spec/setup` · `spec/operations` · `decision/vps-capacity` · `decision/data-residency` ·
`decision/client-ops-posture` · `decision/ops-access-and-backup-deferral` ·
`research/metrics` (M2, M8, M9) · `KBS-31`, `KBS-32`, `KBS-33` · `docs/runbook/dns-records.md` ·
`docs/runbook/deploy.md`.
