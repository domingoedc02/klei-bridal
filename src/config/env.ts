/**
 * The ONE place `process.env` is read in this codebase.
 *
 * Every other module imports `env` from here — never `process.env` directly
 * (enforced by the boundaries lint: `src/shared/**` cannot import this file,
 * so a secret can never be re-exported into the browser bundle).
 *
 * Parsed once, at import time, with Zod. A missing or malformed REQUIRED
 * variable throws immediately — the process crashes at boot naming the
 * problem, rather than serving traffic half-configured. See
 * spec/conventions ("Environment variables") and spec/setup's canonical
 * variable table.
 *
 * Variable names below are the ones reconciled across four reviewers on
 * KBS-6 (`VALKEY_URL`→`REDIS_URL`, `RESEND_API_KEY`→`MAIL_PROVIDER_API_KEY`,
 * `MAIL_FROM`→`MAIL_FROM_ADDRESS`, `MAIL_STUDIO_TO`→`STUDIO_ENQUIRY_EMAIL`,
 * `STUDIO_TZ`→`STUDIO_TIMEZONE`, and the dead `MEDIA_ROOT` replaced by
 * `IMAGE_ORIGINALS_PATH` / `IMAGE_CACHE_PATH`). Do not rename these again
 * without updating `.env.example` and every `spec/*` reference in the same
 * change.
 */
// Throws at build time if this module is ever pulled into a client bundle —
// including a "use client" file under app/, which the zone lint cannot see.
import "server-only";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

/** Any `NEXT_PUBLIC_` variable is compiled into the client bundle — never put a secret behind one. */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  // --- Datastores -----------------------------------------------------
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (Postgres)"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required (Valkey speaks the Redis protocol)"),

  // --- Sessions / CSRF --------------------------------------------------
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters — `openssl rand -hex 32`"),

  // --- Site origin -------------------------------------------------------
  SITE_URL: z
    .string()
    .url()
    .refine((v) => !v.endsWith("/"), "SITE_URL must not have a trailing slash"),
  NEXT_PUBLIC_SITE_URL: z
    .string()
    .url()
    .refine((v) => !v.endsWith("/"), "NEXT_PUBLIC_SITE_URL must not have a trailing slash"),

  // --- Mail ----------------------------------------------------------------
  MAIL_PROVIDER_API_KEY: z.string().min(1, "MAIL_PROVIDER_API_KEY is required (Resend)"),
  MAIL_FROM_ADDRESS: z.string().email("MAIL_FROM_ADDRESS must be a valid email address"),
  MAIL_FROM_NAME: z.string().default("Klei Bridal Studio"),
  MAIL_SENDING_DOMAIN: z.string().min(1, "MAIL_SENDING_DOMAIN is required"),
  // Comma-separated list allowed (spec/api: "Where the studio's copy of every enquiry goes").
  STUDIO_ENQUIRY_EMAIL: z.string().min(1, "STUDIO_ENQUIRY_EMAIL is required"),
  MAIL_DRY_RUN: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  MAIL_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
  ALERT_EMAIL: z.string().email().optional(),

  // --- Images ------------------------------------------------------------
  // The kbs-media volume's two subtrees. MEDIA_ROOT is dead — never reintroduce it.
  IMAGE_ORIGINALS_PATH: z.string().min(1, "IMAGE_ORIGINALS_PATH is required"),
  IMAGE_CACHE_PATH: z.string().min(1, "IMAGE_CACHE_PATH is required"),
  IMAGE_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  IMAGE_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26_214_400),
  IMAGE_MAX_PER_GOWN: z.coerce.number().int().positive().default(10),

  // --- Studio-wide settings bootstrap (runtime source of truth is the
  // `settings` table once KBS-9 lands; these are the seed/bootstrap
  // defaults only — request-time code must read `settings`, not these). ---
  STUDIO_TIMEZONE: z.string().min(1).default("Asia/Manila"),
  DEFAULT_CURRENCY: z.string().length(3).default("PHP"),
  MESSENGER_PAGE_HANDLE: z.string().min(1).optional(),
  WHATSAPP_NUMBER: z
    .string()
    .regex(/^\d+$/, "WHATSAPP_NUMBER must be E.164 digits only — no +, spaces or dashes")
    .optional(),
  VIBER_NUMBER: z
    .string()
    .regex(/^\d+$/, "VIBER_NUMBER must be E.164 digits only — no +, spaces or dashes")
    .optional(),

  // --- Observability -------------------------------------------------------
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),

  // --- Seed-only (never read at runtime) ----------------------------------
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Fail loudly, before serving a single request — never fall back to a
    // default for anything security- or delivery-critical.
    throw new Error(
      `Invalid environment configuration — refusing to boot:\n${formatIssues(parsed.error)}`,
    );
  }

  const parsedEnv = parsed.data;

  // Boot-time refusal (spec/conventions, KBS-6-2, KBS-34): a production
  // deploy whose sending address sits outside the verified sending domain
  // fails SPF/DKIM/DMARC alignment, and every enquiry notification lands
  // in spam — silently, with no error anywhere. Converting that into a
  // loud boot failure is the entire point of this check.
  if (parsedEnv.NODE_ENV === "production") {
    const fromDomain = parsedEnv.MAIL_FROM_ADDRESS.split("@")[1]?.toLowerCase();
    const sendingDomain = parsedEnv.MAIL_SENDING_DOMAIN.toLowerCase();
    const matches =
      !!fromDomain && (fromDomain === sendingDomain || fromDomain.endsWith(`.${sendingDomain}`));

    if (!matches) {
      throw new Error(
        `MAIL_FROM_ADDRESS ("${parsedEnv.MAIL_FROM_ADDRESS}") is outside MAIL_SENDING_DOMAIN ` +
          `("${parsedEnv.MAIL_SENDING_DOMAIN}") — refusing to boot in production. Every enquiry ` +
          "notification would silently fail SPF/DKIM/DMARC alignment and land in spam.",
      );
    }
  }

  // Boot-time refusal (KBS-34 AC, KBS-33): delivery-failure alerts sent to
  // the studio's own enquiry inbox are buried among enquiries — and when
  // that inbox is the one bouncing, the alert never arrives at all.
  if (parsedEnv.ALERT_EMAIL) {
    const alert = parsedEnv.ALERT_EMAIL.trim().toLowerCase();
    const studio = parsedEnv.STUDIO_ENQUIRY_EMAIL.split(",").map((v) => v.trim().toLowerCase());
    if (studio.includes(alert)) {
      throw new Error(
        `ALERT_EMAIL ("${parsedEnv.ALERT_EMAIL}") is one of STUDIO_ENQUIRY_EMAIL — refusing to ` +
          "boot. Delivery-failure alerts must go to a separate inbox from enquiries.",
      );
    }
  }

  // Boot-time refusal (KBS-34, security-eng): /media serves `<sha256>.jpg`
  // from the cache root and originals use the same naming, so overlapping
  // roots would publish the photographer's unprocessed masters; and the
  // originals orphan sweep would delete derivatives. Nested counts as overlap.
  const originals = resolve(parsedEnv.IMAGE_ORIGINALS_PATH);
  const cache = resolve(parsedEnv.IMAGE_CACHE_PATH);
  const inside = (child: string, parent: string) => {
    const rel = relative(parent, child);
    // First segment, not a prefix: `..cache` is a child, `../cache` is not.
    return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
  };
  if (inside(originals, cache) || inside(cache, originals)) {
    throw new Error(
      `IMAGE_ORIGINALS_PATH ("${parsedEnv.IMAGE_ORIGINALS_PATH}") and IMAGE_CACHE_PATH ` +
        `("${parsedEnv.IMAGE_CACHE_PATH}") overlap — refusing to boot. They must be separate, ` +
        "non-nested directories, or /media could serve unprocessed originals.",
    );
  }

  return parsedEnv;
}

export const env = loadEnv();
