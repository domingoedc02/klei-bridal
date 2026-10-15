# Deploy & rollback runbook — Dokploy

Owner: devops (Kwame Asante). Written for `KBS-31-2`. Companion to
`docs/runbook/dns-records.md` (KBS-34-1) and `docs/runbook/go-live-checklist.md` (KBS-34-2).
This file owns the Dokploy app configuration, the `kbs-media` named volume, and the
deploy/rollback procedure. The committed GitHub Actions CI workflow is
`.github/workflows/ci.yml` (`KBS-31-1`, `KBS-31`) and is not duplicated here.

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
   - **Build arg:** set `NEXT_PUBLIC_SITE_URL` to the live origin (e.g. `https://<domain>`)
     as a Dokploy **build argument**, in addition to setting it in the runtime env. It is inlined
     into the browser bundle at build time, so the runtime value alone does not change it. It is
     the only build arg, and it is not a secret. No secret is ever a build arg.
   - **Auto-deploy OFF.** Deploys are triggered manually after migrations have run
     (section 2). An auto-deploy on merge would start the new code before its migration.
   - **No host port.** Leave the application's **Ports** list empty. `kbs-web` is reached only
     through Traefik on the Dokploy network, via the **Domains** tab. A published port would
     let a visitor bypass Traefik and the TLS and `X-Real-IP` guarantees below.
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
5. **Confirm Traefik overwrites `X-Real-IP`.** The per-IP rate limiter
   (`src/server/ratelimit/client-ip.ts`) trusts `X-Real-IP` first. Traefik deletes any
   client-sent `X-Real-IP` / `X-Forwarded-*` and sets its own from the TCP peer, **unless**
   the entrypoint trusts the sender. So the static config must not trust everyone:
   ```bash
   docker exec dokploy-traefik cat /etc/traefik/traefik.yml | grep -n -A4 -i forwardedHeaders
   # (same file on the host: /etc/dokploy/traefik/traefik.yml)
   ```
   Pass condition: no output. Or, under `forwardedHeaders`: no `insecure: true` and no
   `trustedIPs` entry wider than a known upstream proxy (never `0.0.0.0/0`).
   - If Cloudflare's **proxied** (orange-cloud) mode is ever switched on, every visitor's
     `X-Real-IP` becomes a Cloudflare edge IP. Tell devops before enabling it: the rate limiter
     then needs `trustedIPs` set to Cloudflare's ranges.
6. **Confirm no host port is published** (after the first deploy):
   ```bash
   docker service ls --format '{{.Name}} {{.Ports}}' | grep kbs-web
   ```
   Pass condition: the ports column is empty for `kbs-web`. Neither `*:3000->3000/tcp` nor any
   other `->` may appear.

**Report back:** the raw output of both commands above.

## 2. Deploy sequence (every time)

1. Run mandatory replica preflight before startup or traffic swap. Exact command:
   ```bash
   pnpm ops:catalogue-cache preflight
   ```
   Run from deploy checkout with Docker access. Output must contain `"count":1`, `"enabled":true`, and `"cacheAction":"enabled"`. Any `null`, `0`, or count greater than `1` exits non-zero, records disabled state, and blocks deploy. Do not set `CI_REPLICA_PREFLIGHT=false`; that bypass is forbidden. Unknown or unavailable Docker fact never means one.
2. Confirm CI is green on the commit being deployed. The GitHub Actions jobs are lint,
   typecheck, unit tests, production build, integration tests, e2e, and the `docker build` +
   container smoke. A red commit never reaches Dokploy.
3. Confirm any pending migration has been **reviewed as SQL by a second person**
   (`AC-OPS-05` — never trigger a deploy carrying an unreviewed migration).
4. **Apply migrations as an explicit step, BEFORE the deploy** (section 2a). This ordering is
   safe only because of the backward-compatible-migration rule (section 5): the
   still-running previous release must work against the new schema. Never run an implicit
   `drizzle-kit push`, which is forbidden against production (`spec/setup`).
5. Trigger the Dokploy deploy manually ("Deploy" in the Dokploy UI; auto-deploy is off).
6. Dokploy swaps the `kbs-web` container; Traefik begins routing to the new one once its
   healthcheck passes.
7. **Run the persistent-volume check immediately** — section 3 below. This is not optional
   and not "spot check if you remember."
8. Smoke-check: homepage, one gown page, `/admin/login`, submit one test enquiry.

### 2a. Running migrations (one-off container)

The runtime image **cannot** migrate: it has no `tsx` and no `drizzle/migrations/*.sql`, by
design (KBS-7). Migrations run from the Dockerfile's **`builder` stage** as a one-off container
that exits when done. CI runs exactly this path on every PR, twice in a row, to prove it is
idempotent (`scripts/ci-docker-smoke.sh`). Run it on the VPS shell, at the commit about to be
deployed:

```bash
cd /tmp && rm -rf kbs-src && git clone --depth 1 https://github.com/domingoedc02/klei-bridal kbs-src
cd kbs-src && git log -1 --format='%h %s'          # must be the commit you are deploying
docker build --target builder -t kbs-migrate:$(git rev-parse --short HEAD) .

# Same environment as the running app: copy it from the live kbs-web container.
umask 077
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \
  "$(docker ps -q --filter name=kbs-web | head -1)" > /tmp/kbs.env
docker run --rm --network dokploy-network --env-file /tmp/kbs.env \
  kbs-migrate:$(git rev-parse --short HEAD) \
  node_modules/.bin/tsx --conditions=react-server scripts/migrate.ts
rm -f /tmp/kbs.env                                 # it holds DATABASE_URL — never leave it
cd /tmp && rm -rf kbs-src
```

- The last line before exit must be `Applied N migration(s). Up to date.` or
  `Already up to date — nothing to apply.`. The exit code must be 0.
- Any `checksum mismatch` means an already-applied migration file was edited. **Stop.** Do
  not deploy, and send devops the output.
- For the **first ever deploy** there is no running `kbs-web` to copy env from. Create
  `/tmp/kbs.env` by hand from the Dokploy env config (one `KEY=value` per line), then delete
  it the same way.
- If the `dokploy-network` name differs, use the network that the Postgres service is on
  (`docker network ls`).

**Report back:** the `git log -1` line and the full migrate output.

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
#   -> Treat as a deploy-blocking incident. Roll back (section 5) immediately,
#      then fix the Dokploy volume configuration before redeploying.

# Then verify every row has its full derivative set on disk.
# The runtime image has no pnpm, so this runs in the one-off builder-stage container
# from section 2a, with the volume mounted and the app's env:
#   docker run --rm --network dokploy-network --env-file /tmp/kbs.env \
#     -v kbs-media:/data/media kbs-migrate:<sha> pnpm images:verify
# (`images:verify` itself lands with KBS-13.)
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

**What CI already proves, and what it can't.** On every PR, `scripts/ci-docker-smoke.sh` checks
the image side. It boots the built image twice in a row on one named volume, and confirms that
a derivative written by the first container is still there for the second. It also fails the
build if the image ever declares a `VOLUME`. What CI cannot prove is that **Dokploy's app
config** mounts `kbs-media` at `/data/media`. That lives on the VPS, so the two-deploy proof
below is still required there.

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
