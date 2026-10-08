# Developer handbook — Klei Bridal Studio showcase site

**The first document a new developer on Klei Bridal Studio reads.** Each section is readable on its
own and ends by citing the `spec/*` key that holds the full detail. Discovery is signed off (13/13
topics); the spec pack is complete.

This handbook is transcribed, section for section, from the eighteen approved sections carried on
ORBIT issue **KBS-1** and its subtasks **KBS-1-1 … KBS-1-4** (project **KBS**, in ORBIT). ORBIT is the
source of truth: if this copy and the ORBIT pages ever disagree, treat it as drift and flag it rather
than silently "fixing" either one. The parts:

1. **This page** — Overview · Target audience · Features · Tech stack · Spec index. *(KBS-1)*
2. [`02-file-structure-getting-started-environment.md`](./02-file-structure-getting-started-environment.md)
   — File structure · Getting started · Environment & secrets. *(KBS-1-1)*
3. [`03-middleware-api.md`](./03-middleware-api.md)
   — Middleware · API structure · API flows. *(KBS-1-2)*
4. [`04-user-flows-security.md`](./04-user-flows-security.md)
   — User flows · Security flow · Security setup. *(KBS-1-3)*
5. [`05-operations-testing-conventions-glossary.md`](./05-operations-testing-conventions-glossary.md)
   — Operations · Testing · Conventions · Glossary. *(KBS-1-4)*

---

## Overview

Klei Bridal Studio is a bridal studio. This is **their gown showcase website**: one page per wedding gown, so a bride can see the detail, save the gowns she loves, and send an enquiry that already says which gowns she means.

**It is not a shop.** There is no cart, no checkout and no payment anywhere in the system — the client's own framing was *"instead of add to cart"*. A gown at this price is bought after an appointment and a fitting, so the conversion event is **an answered enquiry**, never a transaction. One consequence is worth knowing on day one: the project has **no PCI scope at all**. Protect that.

The shape of the product:

1. **A filterable catalogue** of gowns, filtered by silhouette, material and collection — and those filter values are **data the studio edits themselves**, not a list in our code.
2. **A page per gown** with 6–10 photographs, a tap-to-zoom view, and an **exact public price**.
3. **A heart button** that saves gowns to a favourites list held **only in the bride's own browser**.
4. **An enquiry form** carrying her chosen gowns, her details (remembered from her last visit, again only in her browser) and her **wedding date**, which is required.
5. **After submitting:** the enquiry is emailed to the studio *and* copied into admin — it is complete at that point — and she is shown a short link, which she may carry into **Messenger or WhatsApp/Viber**, whichever she prefers.
6. **An admin area** where staff upload new arrivals, manage collections, and edit the filter vocabulary — in release 1, not later.

Two facts govern almost every technical decision here. **Half of all discovery is social** — brides arrive from a Facebook or Instagram link — so pages must be server-rendered with correct `og:` tags, or a link-preview scraper gets a blank page. And the site is **self-hosted on the client's own VPS** via Dokploy, so there is no managed platform absorbing our mistakes: no CDN, no serverless autoscaling, and one box running the app, Postgres, Valkey and image encoding together.

**Live by mid-December 2026**, about ten weeks from kick-off. No build budget was ever disclosed despite three asks, so **scope is sized against the date, not against money** — which is why `decision/cut-order` exists and why you should read it before proposing anything extra.

→ Full detail: `brief/requirements`, `spec/overview`, `plan/raid`.

---

## Target audience

**Two groups use this software, and they are not alike.**

**The bride.** Getting married in roughly 6–18 months. She found the studio in a social post or had a link sent to her. She browses on her **phone and on her laptop, and both are top priority** — this was the client overruling our phone-first proposal in their own words: *"Make it responsive! It is must be ok with any screen sizes. But Phone and Laptop size is most priority"*. So **every page is designed and reviewed at both widths**; neither is a degraded copy of the other. She does not shop alone — gown pages get screenshotted into family group chats, and she often returns on a laptop with her mother to decide. She shops across weeks, not in one session, which is what the favourites list is actually for.

**The overseas or destination bride.** Explicitly in scope: Filipinos abroad and destination weddings. She is the **highest-value enquiry in bridal and the one least able to walk in**, so she depends entirely on the photography and on tap-to-zoom to judge a gown. She may be on poor mobile data, which is why image weight is a hard requirement and not a nicety. She may not use Messenger at all, which is why both chat hand-offs exist. And she puts the project on a **GDPR-grade footing** if any bride is in the EU or UK; the Philippine Data Privacy Act applies regardless.

**The studio staff member.** Not a developer. Uses admin during their **holiday season**, which is when the catalogue has to be loaded. They will try to upload 8 MB camera originals and expect it to work. They currently answer brides in Facebook DMs and are comfortable there — so the biggest adoption risk in this project is not the code, it is asking them to watch an admin inbox *and* two chat channels instead.

Personas are written in full, each statement marked CONFIRMED or ASSUMPTION, in `spec/overview/personas` — **no acceptance criterion may rest on an ASSUMPTION without flagging it.**

→ Full detail: `spec/overview`, `spec/overview/personas`, `research/users`.

---

## Features

The agreed release-1 scope, as MoSCoW. This is a summary; the authoritative list with every clause is `spec/overview/features`.

**MUST — release 1**

| Feature | What it means |
|---|---|
| Gown catalogue, a page per gown | Clean shareable URL `/gowns/<slug>`, **slug immutable once published** so a link in a bride's DM thread keeps working. Server-rendered with per-gown `og:` tags |
| Filters | Silhouette, material, collection — filter state in the URL so a filtered view is shareable |
| Admin-editable vocabulary | Silhouettes, materials and collections are **database rows, never enums**. Staff add them, with a near-duplicate warning, a **merge** action, and refusal to delete a tag still in use |
| 6–10 photographs per gown | Staff upload the photographer's original; the site generates every size. **Tap-to-zoom** gives a full-quality view |
| Exact public prices | Integer minor units, PHP with the ISO code visible, plus an `on_request` state so a new arrival mid-upload does not look broken |
| Favourites | Heart button, stored in the bride's browser only |
| "Send my list" email | The **only** bridge that gets her shortlist from her phone to her laptop |
| Enquiry form | Her gowns, her remembered details, and a **required wedding date** with a non-blocking lead-time notice |
| Enquiry delivery | Email to the studio **and** a copy in admin. The enquiry is complete here |
| Short link + two chat hand-offs | `KB-7G4H-2XQM`-style reference plus a link; **Messenger** (one tap, link auto-copied to clipboard, she pastes and sends) or **WhatsApp/Viber** (genuinely prefilled, she only presses send) |
| Admin | Multi-image upload with ordering and a hero image, collections, enquiry inbox, staff accounts, settings |
| Named staff logins | One account per person, **single permission level** in release 1 |
| Enquiry source attribution + dashboard | Enquiries per month split social / search / direct — the client's one success metric |

**SHOULD / COULD** are in `spec/overview/features`. If the date comes under pressure, cut in the order the client confirmed: **tap-to-zoom → the second chat channel → collections management → "send my list"**. Note that *"send my list"* is deliberately **last**: removing it breaks the phone↔laptop requirement above, and the client has been warned of that three times.

**WON'T — and nothing on this list returns by any route, including via the cut order**

- **No cart, checkout or payments** → no PCI scope.
- **No bride accounts.** No visitor logins, no password resets for brides.
- **No Messenger bot in release 1** — deferred because Meta App Review is outside our control and was the largest threat to the date.
- **None of these Allure features**, which the client explicitly excluded when they chose allurebridals.com as a *look* benchmark only: **lookbooks, store locator, colour/size variants, trunk-show calendar**.

→ Full detail: `spec/overview/features`, `brief/requirements`, `decision/cut-order`.

---

## Tech stack

Every version is a **pin to verify at kick-off**. The ADR column names the decision that chose it — read the ADR before proposing a change.

| Layer | Choice | ADR |
|---|---|---|
| Framework | **Next.js, App Router only** (no `pages/`), React, TypeScript strict | `decision/tech-stack` |
| Runtime | **Node LTS**, containerised with `output: 'standalone'` and a multi-stage Dockerfile | `decision/tech-stack` |
| Rendering | **Server-side rendering / ISR — forced, not preferred** | `decision/rendering` |
| Database | **Postgres 17** as a Dokploy service, **Drizzle ORM**, SQL migrations committed to the repo | `decision/tech-stack` |
| Primary keys | **UUIDv7** everywhere — time-ordered and opaque. Never an autoincrement integer in a public URL | `decision/data-model-shape` |
| Cache / rate limiting | **Valkey 8** (Redis-compatible) as a Dokploy service | `decision/tech-stack` |
| Images | **`sharp` on the box**, generated widths, AVIF/WebP, behind a **persistent cache volume** | `decision/images` |
| Admin auth | **Our own session table** — a hashed 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie | `spec/security` |
| Email | **Third-party transactional service** (Resend), verified sending domain, SPF/DKIM/DMARC | `decision/tech-stack` |
| Hosting | **The client's own VPS via Dokploy**, Traefik with automatic Let's Encrypt TLS | `decision/tech-stack`, `decision/vps-capacity` |
| Errors | Sentry/GlitchTip free tier, `pino` JSON logs | `spec/operations` |

**Three things that are deliberately NOT in this stack**, so nobody reintroduces them:

- **Vercel, Neon and Cloudinary are out.** Not on merit — the client chose to self-host on a VPS they already own and administer, and separately rejected a third-party image CDN. The earlier managed-hosting plan is void.
- **Auth.js is out for sessions.** The architect first specified Auth.js Credentials with database sessions; its Credentials provider **cannot** use database sessions — it forces a JWT, which is not server-revocable. That would have made the client's "disable a leaver's account" requirement quietly untrue, so `security-eng` overruled it in favour of our own session table. Do not re-add it.
- **Self-hosted SMTP is forbidden.** A fresh VPS IP has no sending reputation and enquiry mail would land in spam. Email is the one thing that must stay off the box.

**Capacity.** The VPS is confirmed at **4 vCPU / 8 GB RAM / 80 GB disk**, which is why builds can happen on the box rather than in CI. It is sized tightly on purpose: steady state is 2–3 GB, but a Docker build peaks at 2–4 GB and a `sharp` AVIF encode of a 24 MP original peaks at 300–600 MB per worker, and those peaks overlap on a redeploy. Hence two standing rules: **image encoding is always a bounded background queue, never inline on a request**, and **the image cache volume must survive redeploys**.

> **Note on the zoom asset figure (kept current as of 2026-10-08).** The zoom derivative is **2048px, AVIF primary with a WebP fallback**, budgeted at ≤600KB transferred and ≤4.0s time-to-interactive-zoom on the AC-PERF-01 profile — see `decision/images` §2.1. An earlier draft of that ADR specified 2560–3200px at WebP q88–92; that figure could not meet the transfer budget on high-frequency lace/beading detail and was superseded at plan review (after `KBS-12`'s review round). **If you see 2560–3200px or "WebP q88–92" for the zoom asset anywhere — code, comments, or another doc — it is stale; the current, reconciled figure is the one above.**

→ Full detail: `spec/architecture`, `decision/tech-stack`, `decision/vps-capacity`.

---

## Spec index

Every specification and decision key, with what it holds. Cite these from issues rather than restating them.

**The agreed basis**
- `brief/requirements` — the signed-off requirements: goal, users, MoSCoW, non-goals, constraints, NFRs, timeline, the cut order, 13 open questions.
- `plan/raid` — risks, assumptions, issues and dependencies, each with an owner and a next action.
- `discovery/log` — all five interview rounds and the client's verbatim words.
- `answer/<topic>` — the 13 settled discovery topics, each with the choice, the reason and the trade-off accepted.

**Specification pack**
- `spec/overview` — product, audience, personas, problem, features, non-goals, success metrics. Sub-keys: `/features` (full MoSCoW and every non-goal with its reason), `/personas` (four personas with the A1–A7 assumption register).
- `spec/architecture` — tech stack, system context, containers, components, **the `withPipeline` request chain**, integrations, quality attributes. Sub-keys: `/integrations` (every outbound integration and exactly how it fails), `/quality-attributes` (each NFR with its number and how it is verified).
- `spec/file-structure` — the real repository tree, enforced module boundaries, naming, and where each kind of new code goes. **Wins over `spec/conventions` on layout.**
- `spec/data-model` — entities, relationships, keys and constraints, migrations, the personal-data register, lifecycle and retention.
- `spec/api` — style and versioning, authentication, a table per resource, the single error envelope, pagination and filtering, idempotency and rate limits.
- `spec/flows` — user flows UF1–UF6, API flows, background jobs and events, and every failure path, numbered one actor per line.
- `spec/security` — threat model, authentication, session and token handling, the authorization matrix, middleware and headers, secrets, validation, rate limiting, audit logging, and a deployer's checklist.
- `spec/setup` — clean machine to running app: prerequisites, every environment variable, first run, local services, seeds, troubleshooting. Sub-keys: `/seed`, `/troubleshooting`.
- `spec/operations` — environments, CI/CD, deployment and rollback, observability, backup and restore, cost.
- `spec/testing` — strategy, test levels L1–L5, test data, acceptance-criteria style, Definition of Done. Sub-keys: `/acceptance-criteria` (enquiry and chat), `/acceptance-criteria-nfr` (short link, responsive, performance), `/acceptance-criteria-admin` (admin, accessibility, the two operational drills), `/test-data`, `/storage-matrix` (the eight localStorage states), `/environments-and-tooling`, `/definition-of-done`.
- `spec/conventions` — branching and commits, code review, Definition of Ready, coding standards. **Wins over `spec/file-structure` on process.**

**Decisions (ADRs)**
`decision/tech-stack` · `decision/rendering` · `decision/images` · `decision/data-model-shape` · `decision/category-vocabulary` · `decision/pricing-display` · `decision/enquiry-link` · `decision/favourites-storage` · `decision/lead-time-rule` · `decision/analytics-attribution` · `decision/cut-order` · `decision/vps-capacity`

**Research**
`research/users` · `research/competitors` · `research/domain-rules` · `research/metrics`

---

## References

`brief/requirements` · `plan/raid` · `spec/overview` · `spec/architecture` · `decision/tech-stack` · `decision/vps-capacity` · `decision/cut-order` · `discovery/log`

*Source: ORBIT issue `KBS-1`. Subtasks `KBS-1-1` … `KBS-1-4` carry the remaining thirteen sections — see the part files listed at the top of this page.*
