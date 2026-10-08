# Klei Bridal Studio — runtime image (KBS-7-1).
#
# Base is glibc (`bookworm-slim`), NOT Alpine: `@node-rs/argon2` (and `sharp`
# when the image pipeline lands) ship prebuilt binaries for glibc and musl is
# the recurring "works locally, fails in the container" bug — decision/tech-stack.
#
# Three stages: deps (lockfile install) / builder (next build) / runner
# (traced standalone output only). The runner carries no devDependencies, no
# `tests/`, no source tree and no package manager.
#
# NO SECRET IS EVER BAKED INTO A LAYER. The builder's env block below is
# deliberately dummy, non-secret and build-time only; every real value is
# injected by Dokploy at container start (spec/security, secrets management).

# ---------------------------------------------------------------- deps --------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

# pnpm version comes from package.json#packageManager — never pinned twice.
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ------------------------------------------------------------- builder --------
FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next build` imports src/config/env.ts (the only reader of process.env), and
# its Zod schema refuses to boot on a missing required variable — so the build
# needs a complete environment even though nothing here reaches the runtime
# image. The values are obviously fake placeholders set on the RUN line only,
# so they never become ENV in any stage's config. NEXT_PUBLIC_SITE_URL is
# inlined into the client bundle, so it is an ARG a real build sets.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NODE_ENV=production
RUN SITE_URL="$NEXT_PUBLIC_SITE_URL" \
    NEXT_PUBLIC_SITE_URL="$NEXT_PUBLIC_SITE_URL" \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    REDIS_URL=redis://127.0.0.1:6379 \
    SESSION_SECRET=build-time-placeholder-not-a-secret-000000 \
    MAIL_PROVIDER_API_KEY=build-time-placeholder \
    MAIL_FROM_ADDRESS=build@build.invalid \
    MAIL_SENDING_DOMAIN=build.invalid \
    STUDIO_ENQUIRY_EMAIL=build@build.invalid \
    IMAGE_ORIGINALS_PATH=/data/media/originals \
    IMAGE_CACHE_PATH=/data/media/derivatives \
    pnpm build

# -------------------------------------------------------------- runner --------
FROM node:24-bookworm-slim AS runner
WORKDIR /app

# Non-secret settings only. HOSTNAME=0.0.0.0 is required: the standalone
# server binds localhost by default and would be unreachable from Traefik.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    IMAGE_ORIGINALS_PATH=/data/media/originals \
    IMAGE_CACHE_PATH=/data/media/derivatives

# `node` (uid 1000) ships with the base image — no user creation needed.
# /data/media is the mount point for the `kbs-media` named volume, created
# here so it exists and is writable by uid 1000 before anything mounts over it.
#
# There is deliberately NO `VOLUME /data/media` instruction: per
# docs/runbook/deploy.md that silently falls back to ephemeral storage
# and the whole catalogue re-encodes on every deploy. The volume is declared
# in Dokploy (production) and in docker-compose.yml (local), never here.
RUN mkdir -p /data/media/originals /data/media/derivatives \
    && chown -R node:node /data/media

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node
EXPOSE 3000

# No curl/wget in the slim image; the runtime's own fetch is enough.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
