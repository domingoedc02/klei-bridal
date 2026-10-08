← [`03-middleware-api.md`](./03-middleware-api.md) | **User flows · Security flow · Security setup** | [`05-operations-testing-conventions-glossary.md`](./05-operations-testing-conventions-glossary.md) →

*Source: ORBIT issue `KBS-1-3` (subtask of `KBS-1`).*

---

## User flows

Six flows cover the product. Each is numbered one actor per line in `spec/flows` (UF1–UF6); this is what they are and why each matters.

**UF1 — Social-link landing, browse, filter.** A bride taps a Facebook or Instagram post link and lands **directly on a gown page**, not a homepage. The server resolves her acquisition source from UTM parameters (else a classified `Referer`, else `direct`) and sets a first-party cookie. She then browses the catalogue and filters by silhouette, material and collection, with **filter state in the URL** so the view is shareable. This flow is why server-side rendering is non-negotiable: half of all discovery is social, and a client-rendered page hands a link-preview scraper a blank document.

**UF2 — Favourites, and "send my list".** She taps the heart on gowns she loves. The list is written to `localStorage` (`kbs.favourites.v1`) — **there is no server copy**. Because the client made phone *and* laptop co-equal priorities, the **"send my list" email is the only bridge between them**: one tap emails her shortlist to herself, and optionally to the studio. If she never taps it, the list genuinely does not survive a change of device, and **the interface must say so plainly rather than implying permanence.**

**UF3 — The enquiry.** The form opens with her selected gowns already attached and her personal details auto-filled from `localStorage` (`kbs.contact.v1`) — the client's original requirement, so she never retypes. She enters her **wedding date, which is required**. If it falls inside the make-to-order window she immediately sees a **lead-time notice offering her options** — an in-stock gown or a rush order — **never a refusal, and it never blocks submission**, because a rush order is a real sale. She submits.

**UF4 — Confirmation and the chat hand-off.** She sees her reference and short link, and **both chat buttons side by side, and she picks**. The two behave differently and the UI must set the right expectation for each: **Messenger** opens the Page chat and copies the short link to her clipboard — *she still pastes and presses send*; **WhatsApp/Viber** opens with the whole message **already typed** — she only presses send. Auto-sending is impossible on every platform, which is why these are the two honest options. **A bride who closes the tab here is not a lost lead** — the enquiry was complete the moment it was emailed and copied to admin.

**UF5 — Staff reply.** A staff member reads the enquiry in email or the admin inbox, opens the short link for the full detail (which writes an audit entry naming them), and replies **in whichever channel she chose**.

**UF6 — Staff admin.** Upload a new arrival with 6–10 photographs, order them, set the hero, set an exact price **or leave it `on_request`**, tag silhouettes and materials, and — when the vocabulary drifts — **create a new value or merge a near-duplicate**.

**The failure paths matter as much as the happy ones**, and `spec/flows` enumerates them: `localStorage` blocked, full, cleared or evicted; the enquiry email bouncing or delayed (the admin copy is the safety net); the clipboard write failing (the visible short link is the fallback); double submission; an oversized or wrong-type upload; the short link scraped for a preview card; and a bride inside the lead-time window submitting anyway.

→ Full detail: **`spec/flows`**, **`spec/overview/personas`**.

---

## Security flow

**What this system actually holds.** Server-side personal data is **submitted enquiries only**: her first and last name, international contact number, email, message, wedding date and chosen gowns. Favourites and her remembered form details live **only in her browser and never reach the server** — a genuine privacy advantage worth preserving. **There are no payments anywhere, so no PCI scope**, and **no bride accounts**, so no visitor credentials to protect.

**Staff authentication, step by step:**

1. A staff member POSTs email and password to the sign-in endpoint.
2. The rate limiter keys on IP and account, with backoff — a credential-stuffing attempt is throttled before it is cheap.
3. The password is verified against an **argon2id** hash.
4. On success the server mints a **256-bit random session token**, stores **only its hash** in the `sessions` table, and sets it in a cookie: **`HttpOnly; Secure; SameSite=Lax; Path=/`**, host-only.
5. On every subsequent request the pipeline hashes the cookie value, looks the session up, and **joins it against `staff_user.is_active`**.
6. The session has a **sliding 24-hour idle timeout and a 14-day absolute cap**.
7. It is **revoked** on sign-out, on password change or reset, and **when the account is disabled**.

**Why it is built this way, and why you must not "simplify" it.** The architect originally specified Auth.js with Credentials and database sessions. Auth.js's Credentials provider **cannot** use database sessions — it forces a JWT, which is **not server-revocable**. The client chose named accounts specifically so that **disabling a leaver's account is how a departure is handled**; with a JWT that person stays signed in until expiry, and the requirement would have been quietly false. `security-eng` therefore overruled the architect. **Do not reintroduce Auth.js for sessions.**

**Authorization.** Release 1 has **one permission level**: every signed-in staff member can manage gowns *and* read every bride's contact details. This was the client's choice over two levels, to protect the mid-December date. It is recorded as an **accepted residual risk**, and **two levels (an uploader who never sees contact details) is the first post-launch security improvement.** The audit log is what makes a single level accountable.

**The one HIGH-impact exposure path** is the enquiry short link, because **she pastes it into a chat and Facebook or WhatsApp will fetch it, unauthenticated, to build a preview card**. Hence: neutral `og:` tags carrying no personal data, full detail only behind a staff session, `noindex`, a 256-bit token stored hashed, non-sequential references, and an identical response for unknown tokens so it cannot be enumerated.

**Audit logging is append-only** and covers gown create/update/delete, category create/merge/delete, **price changes** (prices are public, so a disputed price needs history), **enquiry views** (who read a bride's details), and staff account changes. Accounts are **disabled, never deleted**, so the trail survives.

**Compliance.** The Philippine Data Privacy Act applies regardless. **GDPR-grade duties apply** because overseas and destination brides put EU/UK data subjects in scope. No HIPAA, no PCI, no SOC 2.

→ Full detail: **`spec/security`**, **`decision/enquiry-link`**, **`decision/favourites-storage`**.

---

## Security setup

A checklist a deployer ticks. `spec/security` carries the full version with every header value.

**Before the first deploy**

- [ ] All secrets set in **Dokploy's environment configuration** — never in the repository, never in a committed `.env`.
- [ ] Session secret generated with a CSPRNG, stored only in Dokploy.
- [ ] TLS live via Traefik and Let's Encrypt; **HSTS** set.
- [ ] Security headers in place: CSP, `X-Content-Type-Options`, `Referrer-Policy`, frame options. CSP interacts with server rendering — see `decision/rendering`.
- [ ] `X-Robots-Tag: noindex` on the short-link route.
- [ ] Rate limits configured on the enquiry form and the login; confirm the behaviour **when Valkey is down** (the public writes fail closed; the analytics channel endpoint deliberately fails open).
- [ ] Upload limits enforced: file type, file size, count per gown.
- [ ] Admin created with a real password; **no shared account exists**.
- [ ] The sending domain verified with **SPF, DKIM and DMARC** — which requires the **live domain and a published privacy policy**, so schedule it early.

**Two release gates — neither is optional, and neither has been done yet**

- [ ] **A backup restore has been performed and timed.** Scheduled offsite Postgres backups already run on the client's VPS, but **a restore has never been exercised**. Untested backups are not backups, and **brides' enquiries are the one irreplaceable thing in the system**. Record the RPO and RTO you actually achieve.
- [ ] **The image cache volume survives a redeploy.** Verify by deploying **twice** and confirming the derivative count does not reset. If the volume is ephemeral, every deploy re-encodes the entire catalogue on the same box running Postgres and serving brides — and it stays invisible until the second deploy.

**Also back up:** the **uploaded gown originals** (irreplaceable if the photographer's files are gone) and the environment configuration — Postgres alone is not enough.

**⚠ Three items still unresolved, which a new developer should not assume away:**

1. **The VPS provider and region are unknown** — asked three times in discovery. `spec/security`'s data-residency and lawful-basis section is written **conditionally** until answered.
2. **The enquiry retention period is unconfirmed.** 24 months then anonymise is the team's recommendation; **no automated deletion job ships without the client's explicit sign-off**, and it is built disabled behind a settings flag.
3. **Whether a privacy notice and consent checkbox appear on the form, and who writes that text.** The team cannot write the client's privacy policy, and its publication gates mail-domain verification.

→ Full detail: **`spec/security`**, **`spec/operations`** (backup and restore procedure), **`plan/raid`** (R9, R10).

---

## References

`spec/flows` · `spec/security` · `spec/operations` · `spec/overview/personas` · `plan/raid` · `decision/enquiry-link` · `decision/favourites-storage` · `decision/rendering` · `decision/lead-time-rule` · `answer/data-privacy` · `answer/security-compliance`
