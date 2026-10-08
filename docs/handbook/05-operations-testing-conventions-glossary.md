← [`04-user-flows-security.md`](./04-user-flows-security.md) | **Operations · Testing · Conventions · Glossary**

*Source: ORBIT issue `KBS-1-4` (subtask of `KBS-1`).*

---

## Operations

**Two environments exist: local, and production. There is no staging.** The client has one VPS, and running a permanent second app on it would compete for the same tightly-sized CPU, RAM and disk. **Say what that costs honestly: there is no safe place to rehearse a migration or a restore**, which is exactly why migration review and a tested restore are both hard gates rather than good intentions.

**CI/CD.** Lint → typecheck → test (unit, integration, and Playwright at both gate widths) → container-build verification in CI. Then **Dokploy builds and deploys from the box itself**, which the confirmed 4 vCPU / 8 GB capacity makes safe. Moving the build off-box into CI is the documented fallback if the box ever struggles.

**Deployment and rollback.** Dokploy deploys the multi-stage Dockerfile; Traefik terminates TLS with automatic Let's Encrypt. **Deploy outside studio hours** — a deploy competes with image encoding and with brides browsing. Rollback is redeploying the previous image from Dokploy's history, under a minute. **Migrations must be backward-compatible**, so a rollback is never blocked by a schema the old image cannot read.

**The loudest operational rule in the project.** The media volume must be a **persistent Dokploy named volume**. Verify it on **every** deploy: compare the derivative count before and after, and run the verification command. If it is ephemeral, every deploy re-encodes roughly **19,000 images** on the box that is also running Postgres and serving brides — and the symptom hides until the *second* deploy, which is what makes it dangerous rather than merely bad.

**Backup and restore.** Scheduled offsite Postgres backups already run. **A restore has never been tested, and that is a release gate.** Back up more than Postgres: the **uploaded gown originals** and the **environment configuration**.

**Observability.** Error tracking plus structured JSON logs through Dokploy. The monitors that matter here, in priority order: **disk headroom** (thresholds at 70% and 80%, with Docker build-cache pruning scheduled — a full disk takes the site *and* the database down together), uptime, **email bounce rate**, encode-queue depth, and TLS renewal via the uptime check.

**Cost.** Roughly **$15/year in cash** — the domain; email, error tracking and uptime all sit in free tiers at this volume. But the client now owns, indefinitely and non-optionally: **OS and Docker patching, backup and restore competence, being on call, and disk and TLS awareness**. That is the real price of self-hosting, and it was accepted knowingly.

→ Full detail: **`spec/operations`**, **`spec/setup`**.

---

## Testing

**Risk-ordered, because the date is fixed.** The order is: the enquiry form → `localStorage` → the two chat hand-offs → short-link exposure → responsive widths → performance → admin → accessibility → the two operational drills.

**Levels L1–L5** are defined in `spec/testing`: unit, integration, component, end-to-end, and cross-cutting gates. Playwright runs five projects, including **both gate widths**.

**The four things that make this product distinctive to test:**

1. **Responsive is a requirement, not styling.** Every page is verified at **both phone and laptop width** — the client's own words made them co-equal. It is a Definition-of-Done line, not a preference.
2. **`localStorage` is the riskiest surface in the product.** There are **eight states** in the matrix — blocked, full, cleared mid-session, evicted, absent and more — each inducible on demand, and the required behaviour in every one is identical: **the page renders correctly and nothing throws.** There is no server copy to fall back on, so every failure lands on the page.
3. **The short link's privacy, proved by grep.** A **sentinel bride fixture** uses values that appear nowhere else in the codebase, so an automated search of the unauthenticated short-link response **cannot false-negative**. This lives in acceptance criteria rather than only in the security spec, precisely because the risk is forgetting it during implementation.
4. **Performance against a number:** a gown page in roughly **2–3 seconds on ordinary mobile data** with 6–10 photographs, measured on a throttled profile, with the overseas bride on poor data as the target case.

**Acceptance criteria are Given / When / Then**, one per line, each independently checkable by QA without asking the author. IDs are stable and namespaced — `AC-ENQ-*`, `AC-CHAT-*`, `AC-LINK-*`, `AC-RSP-*`, `AC-PERF-*`, `AC-ADM-*`, `AC-A11Y-*`, `AC-OPS-*`, `AC-STO-*` — and **a story should cite the ID rather than restate the criterion**.

**Definition of Done** is nine universal per-issue items, plus additions by surface touched, plus **two release gates QA will not sign off without: the tested backup restore, and the media volume surviving two consecutive deploys.**

→ Full detail: **`spec/testing`** and its sub-keys — `/acceptance-criteria`, `/acceptance-criteria-nfr`, `/acceptance-criteria-admin`, `/test-data`, `/storage-matrix`, `/environments-and-tooling`, `/definition-of-done`.

---

## Conventions

**Branching and commits are strict for a mechanical reason:** ORBIT links a branch and PR to its issue by finding the **issue key in the branch name and PR title** — so `kbs-14-gown-detail-page`, not `feature/gown-page`. And **move the issue to In progress *before* you create the branch**: ORBIT refuses `dev_link`, `log_work` and `prs.open` on a To-do issue with `not_started`.

**Code review.** A PR's opener cannot approve their own PR. **`security-eng` is the required reviewer on anything labelled `security`.** A `changes_requested` review moves the issue back to In progress, so it is visibly yours again.

**Definition of Ready** — an issue is not startable until: it is in an **active sprint**; its plan is **approved by every planner but its author**; it is estimated; it has an assignee and a reviewer; and, if it belongs to a UI epic, **its epic's responsive prototype is approved**. That last one is enforced — ORBIT holds those issues in To do with `design_not_approved` until five agents and one human have approved the prototype.

**Coding standards** that are specific to this project rather than generic:

- **TypeScript strict.** App Router server/client boundaries respected.
- **Migrations are committed SQL.** Never edit an applied migration; add a new one.
- **`process.env` is read in exactly one typed, validated config module** — never scattered through components.
- **Every `localStorage` read and write is wrapped defensively**, so blocked, full or cleared storage never throws and the page still renders. This is the single most repeated rule in the project because it is the riskiest surface.
- **Prices are integer minor units, never floats**, with an `on_request` unpriced state.
- **Images are never encoded inline on a request** — encoding is a bounded background queue.
- **Accessibility is part of done**: alt text on gown images, and the heart button, filters and zoom view all keyboard-operable.
- **Every page is reviewed at both phone and laptop width.**

→ Full detail: **`spec/conventions`** (process), **`spec/file-structure`** (layout). Where they disagree, conventions wins on process and file-structure wins on layout.

---

## Glossary

**Bridal terms a developer will not know**

| Term | Meaning |
|---|---|
| **Silhouette** | The gown's overall shape — A-line, ball gown, mermaid, sheath, empire. One of the two main filters |
| **A-line** | Fitted at the bodice, widening steadily to the hem like a letter A |
| **Ball gown** | Fitted bodice with a very full skirt |
| **Mermaid** | Fitted through the body to below the knee, then flaring |
| **Empire** | Waistline raised to just under the bust |
| **Train** | The fabric trailing behind the gown. **Brides judge this closely** — it is what appears in every photograph taken from behind, which is why tap-to-zoom exists |
| **Mikado** | A heavy, structured silk blend. One of the material filter values, alongside satin, lace and glitter fabrics |
| **Made-to-order** | A gown cut and sewn for her after she orders. **Needs 2–3 months at this studio** — the confirmed figure that drives the lead-time notice |
| **In-stock** | A gown already in the studio, available far faster. What the lead-time notice offers a bride whose date is too close |
| **Rush order** | A made-to-order gown on a compressed timeline, usually at a surcharge |
| **Fitting** | An in-studio appointment to try on or adjust a gown. The real conversion event the website exists to produce |

**This project's own terms**

| Term | Meaning |
|---|---|
| **Enquiry** | A submitted form: her details, her wedding date and her chosen gowns. Replaces "order" — there is no cart |
| **Favourites** | Her hearted gowns, stored **only in her browser** |
| **"Send my list"** | The email that moves her favourites off one device. The only bridge between her phone and her laptop |
| **Short link** | The link she carries into Messenger or WhatsApp, resolving to her enquiry by a hashed token |
| **Reference** | The human-readable code shown with it, `KB-7G4H-2XQM` shape — 8 characters of Crockford base32, no `0 O 1 I L`, non-sequential |
| **Hero image** | The one photograph representing a gown in the catalogue and in link previews |
| **`on_request`** | A gown with no price set yet, so a new arrival mid-upload does not render as blank or ₱0 |
| **Lead-time notice** | The non-blocking message shown when her wedding date is inside the make-to-order window |
| **Vocabulary / taxonomy** | The silhouettes, materials and collections — **database rows the studio edits**, never enums in code |
| **Merge** | Re-pointing every gown from one tag to a duplicate tag and deleting the source. The only way to remove a tag in use |
| **The cut order** | The client-confirmed sequence in which features are dropped if the date is at risk: tap-to-zoom → second chat channel → collections management → "send my list" |

→ Full index of every spec and decision key: **[`README.md`](./README.md), Spec index**.

---

## References

`spec/operations` · `spec/testing` (and all sub-keys) · `spec/conventions` · `spec/setup` · `spec/file-structure` · `decision/cut-order` · `decision/lead-time-rule` · `research/domain-rules` · `plan/raid`
