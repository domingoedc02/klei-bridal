# Deploy & rollback runbook — Dokploy

Owner: devops (Kwame Asante). Written for `KBS-31-2`. Companion to
`docs/runbook/dns-records.md` (KBS-34-1) and `docs/runbook/go-live-checklist.md` (KBS-34-2).
This file owns the Dokploy app configuration, the `kbs-media` named volume, and the
deploy/rollback procedure — the committed GitHub Actions CI workflow itself is `KBS-31-1`
(backend-dev's), not duplicated here.

## Who runs this

**The client retains sole Dokploy and Hostinger access** (`decision/ops-access-and-backup-deferral`,
`decision/client-ops-posture`) — this is the agreed delivery model, not a gap waiting to be
closed. Every step below that touches the Dokploy UI, the VPS shell, or `docker exec` is
**executed by the client (or whoever they designate)**, not by devops. devops's job is to make
every step unambiguous enough that a non-engineer can follow it exactly and report back
honestly — each section below ends with **"Report back"**: the exact text/output to send back
to devops so the result can be read without guessing. Treat a step with no "Report back" line
as not yet done, however confident the report sounds.

## ⚠ The one thing this runbook exists to prevent

If `kbs-media` is ever configured as ephemeral storage instead of a Dokploy **named volume**,
every redeploy throws away all generated image derivatives and the encode queue re-runs
~19,000 encodes **on the same box running Postgres and serving brides** — a one-line copy
change stalls the site for roughly an hour. **The first deploy after volume creation looks
identical to a correctly-persisted one** — this bug is invisible until the *second* deploy.
That is why AC-OPS-01 (below) requires deploying twice, not once, and why it is written as a
hard gate rather than a suggestion.

## 1. Dokploy app configuration (done once, in the Dokploy UI — never in this repo)

1. **Create the `kbs-web` application** in Dokploy, pointed at this repository's `main`
   branch, building the committed `Dockerfile` (`KBS-7`) directly on the VPS — no registry
   push needed, `decision/vps-capacity` confirmed the box meets the Dockerfile's build
   requirements (4 vCPU / 8 GB peaks at 2–4 GB during build).
2. **Declare `kbs-media` as a Dokploy NAMED VOLUME** — in the application's Volumes/Mounts
   settings, **not** a Dockerfile `VOLUME` instruction and **not** a bind-mount into the build
   context. Mount it at `/data/media` inside the container.
   - This is the single most important line in this entire runbook. The Dockerfile-`VOLUME`
     route is a known failure mode that **silently falls back to ephemeral storage** —
     nothing errors, everything appears to work, and the catalogue re-encodes on every
     deploy. Dokploy's own named-volume mechanism is what survives an image swap; a
     Dockerfile instruction does not.
3. **Set the environment configuration** per `docs/runbook/go-live-checklist.md`'s env var
   table, entered directly in Dokploy's UI. At minimum for the volume to resolve correctly:
   - `IMAGE_ORIGINALS_PATH=/data/media/originals`
   - `IMAGE_CACHE_PATH=/data/media/derivatives`
4. **Confirm Traefik routing** — Dokploy's bundled Traefik v3 holds the route and performs
   automatic Let's Encrypt issuance/renewal once DNS resolves (`docs/runbook/dns-records.md`).
   No TLS configuration happens in this app or this runbook.

## 2. Deploy sequence (every time)

1. Confirm CI is green on the commit being deployed (`KBS-31-1`'s GitHub Actions: lint,
   typecheck, test, e2e, `docker build` verification).
2. Confirm any pending migration has been **reviewed as SQL by a second person**
   (`AC-OPS-05` — never trigger a deploy carrying an unreviewed migration).
3. Trigger the Dokploy deploy (its own webhook on merge to `main`, or manual "Deploy" in the
   Dokploy UI).
4. **Apply migrations as an explicit step** before traffic shifts to the new container
   (`pnpm db:migrate` run once against the new image) — never an implicit `drizzle-kit push`,
   which is forbidden against production (`spec/setup`).
5. Dokploy swaps the `kbs-web` container; Traefik begins routing to the new one once its
   healthcheck passes.
6. **Run the persistent-volume check immediately** — section 3 below. This is not optional
   and not "spot check if you remember."
7. Smoke-check: homepage, one gown page, `/admin/login`, submit one test enquiry.

### Deploy window

Outside studio hours — provisionally **11pm–5am `Asia/Manila`** (⚠ **the studio's timezone is
still unconfirmed** — this window, the lead-time band calculation, and `STUDIO_TIMEZONE`
all assume the same value and move together if the client answers differently).

**This window is quiet for the studio, not for the audience.** Overseas and destination
brides are explicitly in scope, and a bride in Dubai or California may be browsing at exactly
these hours. A deploy here is a deliberate choice to minimise *studio-visible* disruption — it
accepts brief degraded availability for an overseas bride as a known, stated trade-off, not an
absence of consequence. The requirement is that the container swap completes promptly and
rollback remains available within a minute — not that no visitor is ever affected.

## 3. The persistent-volume check (run after EVERY deploy)

```bash
# Before deploying — snapshot the derivative count:
docker exec kbs-web find /data/media/derivatives -type f | wc -l

# Deploy (section 2).

# Immediately after the new container is up — re-count:
docker exec kbs-web find /data/media/derivatives -type f | wc -l
# Must be UNCHANGED, or only grown by exactly what was uploaded since the last deploy.
# A count that dropped to near-zero = the volume did not persist.
#   -> Treat as a deploy-blocking incident. Roll back (section 4) immediately,
#      then fix the Dokploy volume configuration before redeploying.

# Then verify every row has its full derivative set on disk:
pnpm images:verify
# Must report 0 missing.
```

**Report back (copy/paste, don't summarize):** the two raw counts (before/after), and the
full output line from `pnpm images:verify`. A count that merely "looked about the same" is not
a report devops can act on — the numbers themselves are the thing being checked.

## 4. AC-OPS-01 — the deploy-twice proof (run once after initial setup, and after ANY change
   to the Dokploy volume configuration)

**A single deploy is not a valid test.** The first deploy after volume creation is
indistinguishable from a correctly-persisted one — the only way to actually prove persistence
is two deploys with no image changes in between and zero new encode-queue activity on the
second.

1. Confirm the catalogue already has generated derivatives (`pnpm images:verify` reports
   0 missing).
2. Deploy #1 (no image/catalogue changes). Run the volume check (section 3). Watch `kbs-web`
   logs during and shortly after for `image_jobs` claims — note the count (should be zero or
   near-zero, since nothing new was uploaded).
3. Deploy #2, immediately after, still with no image/catalogue changes. Run the volume check
   again.
4. **Pass condition:** after deploy #2, the derivative file count is unchanged from before
   deploy #1 (modulo any genuine uploads in between), `pnpm images:verify` reports 0 missing,
   worker CPU is unchanged, and `kbs-web` logs show **zero new `image_jobs` claims** during
   and after the second deploy. The first gown-page request after deploy #2 has unchanged
   response time (no re-encode happening in the background competing for CPU/disk).
5. **Fail condition:** any of the above drifts — most importantly, a derivative count that
   dropped after either deploy, or `image_jobs` claims appearing on the second deploy with no
   corresponding upload. Treat as the volume falling back to ephemeral storage: stop, fix the
   Dokploy volume config (section 1, step 2), and re-run the whole proof from step 1 — do not
   assume a one-off fix is correct without re-running both deploys.
6. **Report back (not just "it worked"):** the derivative counts before deploy #1, after
   deploy #1, and after deploy #2; the `pnpm images:verify` output after each deploy; and
   whether `kbs-web`'s logs showed any `image_jobs` claims during or after either deploy
   (copy the relevant log lines, or confirm none appeared). devops records pass/fail in the
   "Verification log" below from that report — the client is not expected to judge pass/fail
   themselves, only to run the steps and report what happened.

### Verification log

| Date | Run by | Result | Notes |
|---|---|---|---|
| _(none yet — this proof has not been run against the real Dokploy app. Client-executed once there is a deployable image; devops will record the result here from their report.)_ | | | |

## 5. Rollback

1. Open the `kbs-web` application's deployment history in Dokploy.
2. Select the previous successful deployment and redeploy it.
3. Traefik re-points to the prior container — **typically under a minute, no rebuild.**
4. Run the persistent-volume check (section 3) after a rollback too — a rollback is still a
   container swap and the same risk applies.

**Report back:** the result of the volume check after rollback, and roughly how long the
redeploy took to show as serving again (for the "under a minute" claim to mean something
rather than be assumed).

**This only works cleanly because of one standing rule: every migration must be
backward-compatible with the previous release for at least one deploy cycle**
(add-nullable → backfill → constrain across separate deploys; never drop-and-rename in one
step). Breaking this rule is how a code rollback gets blocked by schema — an undo is always a
forward migration, never an automatic one, so the previous image must still be able to read
the new schema. This is a hard constraint for anyone touching `schema.ts`/migrations, not a
style preference.

## 6. Operational cautions carried from review

- **Rotating `SESSION_SECRET` invalidates every live staff session** (`KBS-27`, since sessions
  are DB-backed, not stateless JWTs). This is the intended emergency control if a session is
  ever suspected compromised, but it is a deliberate action — never done as routine hygiene,
  and never without the team knowing it just signed out the whole studio.
- **Docker build-cache pruning must never overlap the deploy window** — a weekly
  `docker builder prune --filter until=168h` (or Dokploy's own prune control), run outside
  11pm–5am `Asia/Manila` (or whatever window the confirmed studio timezone settles on).
  Never `docker system prune -a` blind; pass `--volumes` only when explicitly intended — it
  can take `kbs-media` with it otherwise.
- **HSTS caution inherited from `KBS-28`:** start with a short `max-age`, confirm at least one
  successful TLS renewal in production, then raise it; no `preload` until renewal has
  succeeded cleanly. On a single box, a renewal failure plus a long cached `max-age` is an
  unreachable site, not a degraded one.

## Reference

`spec/operations` (CI/CD, Deployment & rollback, the media-volume section) · `spec/setup`
(env vars, `pnpm images:verify`/`images:backfill`) · `decision/vps-capacity` ·
`decision/images` §3 · `decision/ops-access-and-backup-deferral` · `decision/client-ops-posture`
(the client-executes delivery model) · `KBS-7` (the Dockerfile this builds) · `KBS-9`
(migrations) · `KBS-13` (encode queue, `images:verify`) · `KBS-27` (session rotation) ·
`KBS-28` (HSTS) · `docs/runbook/go-live-checklist.md` · `docs/runbook/dns-records.md`.
