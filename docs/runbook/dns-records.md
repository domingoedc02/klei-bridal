# DNS & mail-sending domain runbook

Owner: devops (Kwame Asante). Companion to `spec/setup` (env vars) and `spec/operations`
(cost, environments). Written for `KBS-34-1`. Status markers below (✅ / ⚠ BLOCKED) are kept
up to date as client facts arrive — see `decision/vps-capacity` and `decision/data-residency`
in team memory for the infrastructure facts this runbook depends on.

## Who runs this

**The client retains sole Dokploy and Hostinger access** (`decision/ops-access-and-backup-deferral`,
`decision/client-ops-posture`) — that is the agreed delivery model for this whole runbook, not
a gap devops is waiting to close. Every step that needs the registrar panel, the Hostinger
hPanel, the Dokploy dashboard, or Resend's dashboard is **executed by the client**; devops
writes the exact steps and the exact thing to check, and interprets what the client reports
back. A "BLOCKED" row below that reads like a technical access problem resolves only by the
client running the step themselves and reporting the result — not by devops being granted
credentials.

## ⚠ Blocked right now — do not guess these

| # | Fact | Needed for | Status |
|---|---|---|---|
| 1 | **The domain name itself** | Step 1 below — nothing else in this runbook can start until a domain name exists | **IN PROGRESS.** The client has committed to registering the domain this week (`decision/client-ops-posture`). Once registered, devops needs: the exact domain name, and confirmation of where its DNS is managed (registrar's own panel, Hostinger DNS, or elsewhere). |
| 2 | **The VPS's public IP address** | Step 2 (the A record) | **BLOCKED — a client-only fact, not a team access gap.** The VPS's region is confirmed (Hostinger, Singapore, Dokploy-managed, `decision/vps-capacity`), but the client retains sole Hostinger/Dokploy access, so **only the client can read the IP off their own panel and report it back.** This is the permanent delivery model, not something to escalate for team access. |
| 3 | **The real `MESSENGER_PAGE_HANDLE` and `WHATSAPP_NUMBER`** | Not a DNS record, but tracked here because the handover/go-live checklist in `KBS-34-2` depends on the same client conversation that unblocks this runbook. See `docs/runbook/go-live-checklist.md`. | **BLOCKED.** Owner: project-manager. |

Everything below this line is the procedure for **the client to run**, once those facts are
answered — it is written now, while the project is early, exactly because `KBS-34`'s own
context note says domain registration and DNS propagation take days and must not be
launch-week work. Each numbered step ends with **"Report back"**: what to send devops so the
result can be read without guessing.

## 1. Register the domain

- ~$15/year, the only new recurring cash cost in the project (`spec/operations` → Cost).
- Needed as both the canonical site origin (`SITE_URL` / `NEXT_PUBLIC_SITE_URL`, `spec/setup`)
  and the mail-sending domain (`MAIL_SENDING_DOMAIN`, `MAIL_FROM_ADDRESS` must be inside it).
- **Register it before anything else in this file** — every later step reads the domain name.

**Report back:** the registered domain name, the registrar used, and where its DNS is managed.

## 2. DNS records to create

Once the domain and the VPS's public IP are both known, create these records at the
registrar's DNS panel (or point the domain's nameservers at wherever DNS will actually be
managed — Hostinger's own DNS, Cloudflare, or the registrar's default; pick whichever the
client already uses for other domains, so they are not learning a second panel).

| Record | Type | Name | Value | Purpose |
|---|---|---|---|---|
| Apex | A | `@` | `<VPS public IP>` | Public site, root domain |
| WWW | CNAME (or A) | `www` | `@` (or the same IP) | `www.` variant — decide with project-manager whether `www` or apex is canonical and set `SITE_URL` to match, **no trailing slash** |

Dokploy's Traefik instance handles routing and automatic Let's Encrypt TLS issuance/renewal
once these records resolve — **no TLS configuration happens in this runbook or in the app**
(`spec/operations` → Deployment & rollback).

**Report back:** the VPS public IP used, and once DNS has had time to propagate, the output of
`dig +short <domain>` (or `nslookup <domain>`) run from any machine — confirms the record
actually resolves before moving on to step 3.

## 3. Add the domain to Resend and create its verification records

1. In the Resend dashboard, add the sending domain (the same domain as `MAIL_FROM_ADDRESS`,
   tracked separately as `MAIL_SENDING_DOMAIN` — `spec/setup`).
2. Resend generates the exact TXT/CNAME records needed for SPF, DKIM and DMARC. **Copy them
   verbatim from Resend's dashboard at the time — do not reuse the generic shape below from
   memory, the exact host/value pairs are generated per domain.** The shape to expect:
   - **SPF** — a TXT record (often merged into an existing one, Resend's dashboard says
     which) authorizing Resend's sending servers.
   - **DKIM** — typically 2–3 CNAME records Resend asks you to add verbatim.
   - **DMARC** — a TXT record at `_dmarc.<domain>`, policy decided with security-eng
     (`decision/data-residency` and `spec/security` own the compliance posture; this runbook
     only adds the record once a policy is agreed — do not invent `p=reject` vs `p=quarantine`
     without that conversation).
3. Wait for DNS propagation (can take up to 24–48h, usually much faster) and confirm all
   three show **verified** in Resend's dashboard before proceeding.

**Report back:** a screenshot (or copy/paste) of Resend's domain-verification page showing
SPF, DKIM and DMARC each marked verified.

## 4. Prove mail actually delivers

**Enquiry mail in spam is indistinguishable from a broken site** (`KBS-34`). Do not consider
this step done on "Resend says verified" alone:

1. Send one real test email through the app (or Resend's own test-send feature) from
   `MAIL_FROM_ADDRESS` to a **Gmail**, an **Outlook** and a **Yahoo** address.
2. Confirm all three land in the primary inbox, not spam/junk.
3. If any lands in spam: check the DMARC alignment (From domain must match the
   DKIM-signing/SPF domain), and that `MAIL_FROM_ADDRESS` is genuinely inside
   `MAIL_SENDING_DOMAIN` — this exact misconfiguration is why the app refuses to boot in
   production when those two disagree (`spec/setup`, `KBS-34` Security section).

This step cannot run until the privacy policy is published — `KBS-34`'s own sequencing:
**privacy policy published → mail-sending domain verified → every transactional email
works.** Don't jump ahead of that gate even if DNS/Resend verification technically passes
first.

**Report back:** confirmation of which of the three inboxes (Gmail/Outlook/Yahoo) received the
test email in the primary inbox versus spam/junk — not just "it worked."

## 5. Register the mail delivery-event webhook

1. Set `MAIL_WEBHOOK_SIGNING_SECRET` in Dokploy's environment configuration **before**
   registering the webhook — an unsigned window accepts forged bounce events (`KBS-33`,
   `decision` carried in `KBS-34` Security section).
2. Register `POST /api/webhooks/mail` with Resend as the delivery-event destination.
3. Trigger a **test event** from Resend's dashboard and confirm it is received and verified
   by the app. **An unregistered or unverified webhook is a monitor that silently never
   fires** — do not mark this done on "I clicked register," only on a received test event.

**Report back:** the test event's delivery status from Resend's dashboard, and confirmation
(from app logs or admin) that the app actually received and verified it — both halves, not
just that Resend says it sent.

## Reference

`spec/setup` (env var table — `SITE_URL`, `MAIL_*`, `MAIL_WEBHOOK_SIGNING_SECRET`) ·
`spec/operations` (Cost, Deployment & rollback — Traefik/TLS) · `decision/vps-capacity`
(Hostinger, Singapore, Dokploy) · `decision/data-residency` (the privacy-notice hosting
statement this unblocks) · `decision/ops-access-and-backup-deferral` ·
`decision/client-ops-posture` (the client-executes delivery model) · `KBS-34` (parent issue,
full go-live checklist) · `docs/runbook/go-live-checklist.md` · `docs/runbook/deploy.md`.
