← [`02-file-structure-getting-started-environment.md`](./02-file-structure-getting-started-environment.md) | **Middleware · API structure · API flows** | [`04-user-flows-security.md`](./04-user-flows-security.md) →

*Source: ORBIT issue `KBS-1-2` (subtask of `KBS-1`).*

---

## Middleware

Every endpoint runs through one composed chain, **`withPipeline`**, in this execution order. Writing a handler that bypasses it is a review rejection, because each step is a guarantee something downstream relies on.

| # | Step | What it reads | What it refuses, and with what |
|---|---|---|---|
| 1 | **Rate limit** | Client IP, and the route's own budget, counted in Valkey | Too many requests → **429**. The enquiry form and the login have the tightest budgets, as the only public write and the only credential check |
| 2 | **Session** | The `HttpOnly; Secure; SameSite=Lax` session cookie; looks the hashed token up in `sessions`, **joined against `staff_user.is_active`** | Nothing by itself — it resolves an identity or none |
| 3 | **CSRF** | The CSRF token on state-changing requests | A mismatch → **403** |
| 4 | **Authorization** | The resolved identity against the route's requirement | Unauthenticated on an admin route → **401**; authenticated but not permitted → **403** |
| 5 | **Validation** | The request body and query, against a **Zod** schema | A shape or type violation → **400**, with the field named in the error envelope |
| 6 | **Handler** | The validated input | — |
| 7 | **Error mapper** | Any thrown error | Maps to the **single error envelope**; never leaks a stack trace or a database message to a client |

**Four things about this chain that are easy to get wrong:**

- **The session is looked up, not trusted from a token's contents.** This is the whole point of rejecting a JWT: because every request joins the session against `staff_user.is_active`, **disabling a leaver's account takes effect immediately**. A JWT would have left them signed in until expiry, which would have made a requirement the client explicitly chose quietly false.
- **Authorization is always server-side.** Hiding a link or a button is presentation, never access control. Every admin route and endpoint re-checks.
- **Client-supplied IDs are re-validated, always.** Favourite gown IDs arrive from the bride's `localStorage`, which she controls. On every write the server re-checks existence and publication status rather than trusting the payload.
- **There is one deliberate exception to CSRF**, and it is documented: `POST /e/:token/channel` skips step 3, because it is sent with `sendBeacon`, which cannot carry a custom header. It is covered instead by an `Origin` / `Sec-Fetch-Site` check, and its blast radius is one analytics field.

→ Full detail: **`spec/architecture`** (the chain), **`spec/security`** (what each step defends against).

---

## API structure

**REST-shaped JSON over Next.js Route Handlers** (`app/api/**/route.ts`) for programmatic endpoints, and **Server Actions** for form submissions from the app's own pages. Authentication for staff is **the session cookie**, not a bearer token. There is **one error envelope** for every failure, and no endpoint invents its own shape.

The surface, by area:

**Public — the bride**

| Area | What it does |
|---|---|
| Catalogue | List and filter gowns by silhouette, material, collection and price. **Filter state lives in the URL**, so a filtered view is shareable |
| Gown detail | One gown by its **immutable `slug`** — `/gowns/<slug>`. Server-rendered with its own `og:` tags |
| Enquiry submission | The only public write of substance. Accepts her details, her wedding date and her gown IDs; returns the reference and short link |
| Short-link view — `GET /e/:token` | Resolves an enquiry by its hashed token. **Shows no personal data without a staff session** |
| Channel record — `POST /e/:token/channel` | Records which chat channel she tapped. Always returns **204**, for a valid, archived *or* unknown token, so it cannot be used to probe whether an enquiry exists. Fire-and-forget; must never delay the `m.me` / `wa.me` navigation. **Last tap wins** |
| "Send my list" | Emails her favourites to herself, and optionally the studio |

**Admin — staff, session required**

Gown CRUD · image upload, reorder and set-hero · category CRUD **including the merge action** · enquiry list and read · staff account administration · settings (including the lead-time window) · the dashboard, whose response carries the **enquiries-per-month source split and the chat-channel split**.

**Conventions across the whole surface:** primary keys are **UUIDv7** and never appear in a public URL — public addressing is by `slug` for gowns and tags, and by `reference` or token for enquiries. Pagination, filtering, idempotency and per-route rate limits are specified once and applied uniformly.

→ Full detail, with a `method · path · auth · request · response · errors` table per resource: **`spec/api`**.

---

## API flows

Numbered, one actor and one action per line. These are the four that carry the most risk; `spec/flows` has all of them including every failure branch.

**1. Enquiry submission — the single conversion point in the product**

1. Browser POSTs the enquiry (details, wedding date, gown IDs from `localStorage`).
2. Pipeline: rate limit → CSRF → Zod validation.
3. Server **re-validates every gown ID** — exists, published — and rejects the request rather than silently dropping unknown ones.
4. Server evaluates the **lead-time rule** server-side and **stores the band and the exact notice she was shown** on the enquiry, because the window may have moved by the time staff read it.
5. Server generates the reference (`KB-7G4H-2XQM` shape) and a **256-bit token, stored hashed**.
6. Server writes the `enquiries` row and its `enquiry_gowns` — as an **immutable snapshot**, carrying the gown name and price *as they were at that moment*, so a later price edit never rewrites history.
7. **Transaction commits.**
8. **Only then** the email is queued to the studio. Never inside the transaction.
9. Response returns the reference and short link; the confirmation screen renders both chat buttons.

**2. Short-link resolution — the project's one HIGH-impact exposure path**

1. Someone GETs `/e/:token` — and that someone may be **Facebook's or WhatsApp's link-preview scraper**, unauthenticated, because she pasted the link into a chat.
2. Server hashes the token and looks it up.
3. **Without a staff session:** renders the reference and the gown(s) only, with **neutral `og:` tags carrying no personal data**, plus `X-Robots-Tag: noindex`.
4. **With a staff session:** renders the full enquiry, and **writes an audit entry recording who viewed it**.
5. An unknown token returns the same shape as a valid one — no enumeration signal.

**3. Category merge — a transaction, not a loop**

1. Staff POST a merge: source tag → target tag.
2. Server re-points every gown from source to target **in one transaction**, writes the audit entry, and deletes the source.
3. A tag still in use **cannot be deleted** by any other route — merge is the only way to remove one that has gowns.

**4. Price change — audited, because prices are public**

1. Staff PATCH a gown's price.
2. Server writes the new value **and a `price_history` row**.
3. Existing enquiries are untouched — they hold their own snapshot (flow 1, step 6). A bride who screenshots a price can be answered from the history.

**Background work, not request work:** image encoding is a **bounded queue** — roughly 19,000 encodes for a full catalogue, so it must never run inline on a request or it will take the box down with Postgres on it. Outbound email is queued. Acquisition source is stamped at submission from UTM parameters, else a classified `Referer`, else `direct`.

→ Full detail, including every failure path: **`spec/flows`**, **`spec/api`**, **`spec/architecture/integrations`**.

---

## References

`spec/api` · `spec/flows` · `spec/architecture` · `spec/architecture/integrations` · `spec/security` · `decision/enquiry-link` · `decision/analytics-attribution` · `decision/pricing-display` · `decision/category-vocabulary` · `decision/images`
