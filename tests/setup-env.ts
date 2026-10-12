/**
 * Defaults for a local `pnpm test`: the same dummy, non-secret values as the
 * `env:` block in .github/workflows/ci.yml. Anything already exported wins,
 * so CI and a developer's own DATABASE_URL are untouched.
 * ponytail: duplicated from ci.yml; keep the two in step when a required var is added.
 */
const defaults: Record<string, string> = {
  DATABASE_URL: "postgresql://klei:klei_ci_pw@localhost:5432/klei_ci",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "ci-only-session-secret-not-a-real-secret-00",
  SITE_URL: "http://localhost:3000",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  MAIL_PROVIDER_API_KEY: "ci-dummy-key",
  MAIL_FROM_ADDRESS: "enquiries@kleibridal.com",
  MAIL_SENDING_DOMAIN: "kleibridal.com",
  STUDIO_ENQUIRY_EMAIL: "studio@kleibridal.com",
  MAIL_DRY_RUN: "true",
  IMAGE_ORIGINALS_PATH: "./.data/images/originals",
  IMAGE_CACHE_PATH: "./.data/images/derivatives",
  STUDIO_TIMEZONE: "Asia/Manila",
  MAIL_WEBHOOK_SIGNING_SECRET: "ci-only-webhook-signing-secret-not-real",
  ALERT_EMAIL: "ci-alerts@example.invalid",
};

for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
