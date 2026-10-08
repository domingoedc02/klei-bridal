← [`README.md`](./README.md) | **File structure · Getting started · Environment & secrets** | [`03-middleware-api.md`](./03-middleware-api.md) →

*Source: ORBIT issue `KBS-1-1` (subtask of `KBS-1`).*

---

## File structure

One repository, one deployable. **Next.js App Router only — there is no `pages/` directory**, and adding one is a review rejection. Repository root is assumed at `/klei-bridal`, and every command in this handbook runs from there.

The shape you need to hold in your head:

```
/klei-bridal
  app/                     Next.js App Router — routes only
    (public)/              the bride's site: catalogue, gown pages, enquiry, confirmation
    admin/                 staff area, behind the session cookie
    api/                   Route Handlers (route.ts) for programmatic endpoints
  components/              presentational React components, no data access
  lib/                     domain logic, server-only by default
    db/                    Drizzle schema, queries, migrations
    images/                the sharp pipeline and the encode queue
    mail/                  transactional email senders
    config/                the ONE typed module that reads process.env
  public/                  static assets that are not gown photography
  drizzle/                 committed SQL migrations
  tests/                   unit, integration and Playwright specs
```

**Module boundaries are enforced, not advisory.** The rules that matter most:

- **`components/` never touches the database.** Data access lives in `lib/`, and a component that imports from `lib/db` directly is a rejection.
- **`lib/` is server-only by default.** Anything a client component needs must be explicitly safe to ship to the browser.
- **`process.env` is read in exactly one place** — `lib/config/` — which exports a typed, validated object. Scattered `process.env.FOO` through components is a rejection, because a missing variable should fail at boot with a clear message, not silently as `undefined` in a bride's browser.
- **Gown photography never goes in `public/`.** Uploads live on the persistent media volume, served through the image pipeline.

**Where new code goes:** a new page → `app/`, in `(public)/` or `admin/`; a new programmatic endpoint → `app/api/<resource>/route.ts`; a new presentational piece → `components/`; new domain logic or a query → `lib/`; a schema change → a **new committed SQL migration** in `drizzle/`, never an edit to an applied one; a new test → `tests/`, alongside its level.

**Scope boundary, agreed between the architect and the team lead:** `spec/file-structure` owns **where files live and what may import what**; `spec/conventions` owns **branching, commits, review and coding standards**. If they ever disagree, `spec/file-structure` wins on layout and `spec/conventions` wins on process.

→ Full detail, including the complete tree and every enforced boundary: **`spec/file-structure`**.

---

## Getting started

From a clean machine to a running app. `spec/setup` is written so this works from that document alone — this is the orientation, not a replacement.

**Prerequisites.** Node LTS, a package manager, Docker (for local Postgres and Valkey), and `git`. **Versions are pinned deliberately** — match them rather than using whatever is newest, because the production container pins the same ones.

**The sequence:**

1. Clone the repository and install dependencies.
2. Copy the example environment file and fill it in — see **Environment & secrets** below. The app **will refuse to boot** with a missing required variable, which is intentional.
3. Start local services: `docker compose up -d` brings up **Postgres 17** and **Valkey 8**.
4. Apply migrations.
5. **Load the seed data.** This matters more here than on most projects: the seed includes eight gown fixtures, a deliberately dirty taxonomy (near-duplicate tags, so you can exercise the merge action), **a gown left deliberately unpriced (`on_request`)** so you can see that state render, wedding-date boundary values around the lead-time window, and the sentinel bride fixture used by the privacy tests.
6. Create a first admin account.
7. Start the dev server.

**The three things that will go wrong first**, each with its fix in `spec/setup/troubleshooting`: the **media volume path missing or unwritable** (image encoding fails in a way that looks like a rendering bug); **migration drift** between your database and the committed migrations; and a **missing environment variable** surfacing at boot.

**A note on the seed's lead-time values.** The make-to-order window is **2–3 months** — seeded as 13 weeks "comfortable" and 5 weeks "rush floor". Any fixture, test or document citing 4–6 months or 26 weeks is **stale**; the client confirmed the shorter figure at sign-off.

→ Full detail: **`spec/setup`**, plus **`spec/setup/seed`** and **`spec/setup/troubleshooting`**.

---

## Environment & secrets

**Every environment variable is read in one typed module (`lib/config/`) and validated at boot.** A required variable that is absent stops the app with a named error — never a silent `undefined`.

The variables you will actually set, by purpose. **`spec/setup` carries the authoritative table with example values and the required/secret flags for each** — treat that as the source of truth and this as the map.

| Purpose | Variable | Secret? |
|---|---|---|
| Postgres connection | `DATABASE_URL` | **yes** |
| Valkey connection (rate limiting) | `VALKEY_URL` | **yes** |
| Session cookie signing/token hashing | `SESSION_SECRET` | **yes** |
| Transactional email API key | `RESEND_API_KEY` | **yes** |
| Verified sending domain / from-address | sending-domain vars | no |
| Public site origin (used in links and `og:` tags) | `NEXT_PUBLIC_SITE_URL` | no |
| Where uploaded gown originals and derivatives live | media root path | no |
| Messenger Page handle, for the `m.me` link | public handle var | no |
| WhatsApp/Viber business number, for the `wa.me` link | public number var | no |
| Error tracking DSN | Sentry/GlitchTip DSN | no |

**Rules that are not negotiable:**

- **Secrets live in Dokploy's environment configuration, never in the repository.** No `.env` with real values committed, ever — not even briefly, not even on a branch.
- **`NEXT_PUBLIC_*` is shipped to the browser.** Anything with that prefix is public by definition. The Messenger handle and WhatsApp number belong there; nothing else on the secret list does.
- **The session secret and the enquiry-token hashing are security-critical.** Rotating them invalidates live sessions and makes existing short links unresolvable — see `spec/security` for the rotation procedure before you touch either.
- **Email cannot be self-hosted.** A fresh VPS IP has no sending reputation, so enquiry mail would land in spam. The transactional service is a hard dependency, and its sending domain needs **SPF, DKIM and DMARC** configured — which in turn needs the **live domain and a published privacy policy**, so that work is early, not launch-week.

**One open item a new developer should know about:** the **VPS provider and region are still unknown**, asked three times during discovery. It does not block local development, but `spec/security`'s data-residency and lawful-basis section is written **conditionally** until it is answered, and it affects latency for Philippine brides.

→ Full detail: **`spec/setup`** (the variable table), **`spec/security`** (secrets management and rotation), **`spec/operations`** (how they are set in Dokploy).

---

## References

`spec/file-structure` · `spec/setup` · `spec/setup/seed` · `spec/setup/troubleshooting` · `spec/security` · `spec/operations` · `spec/conventions` · `decision/tech-stack` · `decision/lead-time-rule`
