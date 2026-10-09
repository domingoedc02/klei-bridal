#!/usr/bin/env bash
# KBS-31: run the built images the way Dokploy runs them, with dummy values only.
#   1. The runtime image config holds no secret and has no VOLUME, and runs as `node`.
#   2. The one-off migrate container (builder stage) applies migrations, and a
#      second run is a no-op.
#   3. "Deploy" twice against one named volume: a file written by the first
#      container is still there for its replacement. This proves the image side
#      of AC-OPS-01. The Dokploy volume config is proven on the VPS
#      (docs/runbook/deploy.md §4).
#   4. Withholding a required var exits 1 instead of serving.
# Usage: scripts/ci-docker-smoke.sh [runtime-image] [migrate-image]
set -euo pipefail

IMG=${1:-kbs-web:ci}
MIG=${2:-kbs-migrate:ci}
ID=$$
NET=kbs-ci-net-$ID
VOL=kbs-media-ci-$ID
PG=kbs-ci-pg-$ID
VK=kbs-ci-vk-$ID

cleanup() {
  docker ps -aq --filter "name=kbs-ci-.*-$ID" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

ENV=(
  -e "DATABASE_URL=postgresql://klei:klei_ci_pw@$PG:5432/klei_ci"
  -e "REDIS_URL=redis://$VK:6379"
  -e SESSION_SECRET=ci-only-session-secret-not-a-real-secret-00
  -e SITE_URL=http://localhost:3000
  -e NEXT_PUBLIC_SITE_URL=http://localhost:3000
  -e MAIL_PROVIDER_API_KEY=ci-dummy-key
  -e MAIL_FROM_ADDRESS=enquiries@kleibridal.com
  -e MAIL_SENDING_DOMAIN=kleibridal.com
  -e STUDIO_ENQUIRY_EMAIL=studio@kleibridal.com
  -e MAIL_DRY_RUN=true
  -e IMAGE_ORIGINALS_PATH=/data/media/originals
  -e IMAGE_CACHE_PATH=/data/media/derivatives
)

echo "== 1. image config"
cfg_env=$(docker inspect -f '{{json .Config.Env}}' "$IMG")
echo "$cfg_env" | grep -qiE 'SECRET|API_KEY|PASSWORD|DATABASE_URL|REDIS_URL' && fail "secret-like ENV in image config: $cfg_env"
[ "$(docker inspect -f '{{json .Config.Volumes}}' "$IMG")" = null ] || fail "image declares a VOLUME (silently ephemeral under Dokploy)"
[ "$(docker inspect -f '{{.Config.User}}' "$IMG")" = node ] || fail "image does not run as node"
docker history --no-trunc --format '{{.CreatedBy}}' "$IMG" | grep -E '^(ENV|ARG)' | grep -qiE 'SECRET|API_KEY|PASSWORD' && fail "secret-like ENV/ARG in image history"
echo ok

echo "== 2. services + migrations"
docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=klei -e POSTGRES_PASSWORD=klei_ci_pw -e POSTGRES_DB=klei_ci postgres:17-bookworm >/dev/null
docker run -d --name "$VK" --network "$NET" valkey/valkey:8 >/dev/null
for _ in $(seq 1 30); do docker exec "$PG" pg_isready -U klei -d klei_ci >/dev/null 2>&1 && break; sleep 1; done
migrate() { docker run --rm --network "$NET" "${ENV[@]}" "$MIG" node_modules/.bin/tsx --conditions=react-server scripts/migrate.ts; }
migrate | tail -1
migrate | tail -1 | grep -q "Already up to date" || fail "second migrate run was not a no-op"

# Boot one "deploy" of the runtime image on the shared volume; wait for healthy.
deploy() {
  local name=kbs-ci-web$1-$ID status
  docker run -d --name "$name" --network "$NET" -v "$VOL:/data/media" "${ENV[@]}" "$IMG" >/dev/null
  docker exec "$name" test -s /app/src/server/auth/data/common-passwords.txt.gz || {
    docker logs "$name" >&2
    fail "common password list missing from runtime image"
  }
  for _ in $(seq 1 40); do
    status=$(docker inspect -f '{{.State.Health.Status}} {{.State.Running}}' "$name")
    [ "$status" = "healthy true" ] && return 0
    [ "${status#* }" = false ] && { docker logs "$name" >&2; fail "deploy $1 exited"; }
    sleep 2
  done
  docker logs "$name" >&2; fail "deploy $1 never became healthy"
}

echo "== 3. two deploys, one volume"
deploy 1
docker exec kbs-ci-web1-$ID sh -c 'echo derivative > /data/media/derivatives/ci-probe.avif'
docker rm -f kbs-ci-web1-$ID >/dev/null
deploy 2
docker exec kbs-ci-web2-$ID test -f /data/media/derivatives/ci-probe.avif || fail "kbs-media content lost across the container swap"
echo ok

echo "== 4. missing required var exits 1"
BAD=()
for v in "${ENV[@]}"; do [ "$v" = -e ] || [[ $v == SESSION_SECRET=* ]] || BAD+=(-e "$v"); done
docker run -d --name kbs-ci-bad-$ID --network "$NET" "${BAD[@]}" "$IMG" >/dev/null
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Running}}' kbs-ci-bad-$ID)" = false ] && break; sleep 1; done
code=$(docker inspect -f '{{.State.Running}} {{.State.ExitCode}}' kbs-ci-bad-$ID)
[ "$code" = "false 1" ] || fail "expected exit 1 without SESSION_SECRET, got: $code"
echo ok

echo "docker smoke: all checks passed"
