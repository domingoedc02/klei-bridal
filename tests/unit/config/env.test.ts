import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REQUIRED_BASE: Record<string, string> = {
  DATABASE_URL: "postgresql://klei:pw@localhost:5432/klei_dev",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "a".repeat(32),
  SITE_URL: "http://localhost:3000",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  MAIL_PROVIDER_API_KEY: "re_test_key",
  MAIL_FROM_ADDRESS: "enquiries@kleibridal.com",
  MAIL_SENDING_DOMAIN: "kleibridal.com",
  STUDIO_ENQUIRY_EMAIL: "studio@kleibridal.com",
  IMAGE_ORIGINALS_PATH: "./.data/images/originals",
  IMAGE_CACHE_PATH: "./.data/images/derivatives",
};

const ORIGINAL_ENV = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL_ENV };
  for (const [key, value] of Object.entries({ ...REQUIRED_BASE, ...overrides })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function loadEnvModule() {
  // The module parses at import time, so every test needs a fresh module
  // graph to re-run that parse against the env it just set up.
  const mod = await import("../../../src/config/env");
  return mod;
}

describe("src/config/env", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("boots with a complete, valid development configuration", async () => {
    setEnv({ NODE_ENV: "development" });
    const { env } = await loadEnvModule();
    expect(env.DATABASE_URL).toBe(REQUIRED_BASE.DATABASE_URL);
    expect(env.STUDIO_TIMEZONE).toBe("Asia/Manila"); // default applied
    expect(env.MAIL_DRY_RUN).toBe(false); // default applied, coerced to boolean
  });

  it("throws, naming the variable, when a required variable is missing", async () => {
    setEnv({ DATABASE_URL: undefined });
    await expect(loadEnvModule()).rejects.toThrow(/DATABASE_URL/);
  });

  it("throws when SESSION_SECRET is too short", async () => {
    setEnv({ SESSION_SECRET: "too-short" });
    await expect(loadEnvModule()).rejects.toThrow(/SESSION_SECRET/);
  });

  it("refuses to boot in production when MAIL_FROM_ADDRESS is outside MAIL_SENDING_DOMAIN", async () => {
    setEnv({
      NODE_ENV: "production",
      MAIL_FROM_ADDRESS: "enquiries@example.net",
      MAIL_SENDING_DOMAIN: "kleibridal.com",
    });
    await expect(loadEnvModule()).rejects.toThrow(/outside MAIL_SENDING_DOMAIN/);
  });

  it("boots in production when MAIL_FROM_ADDRESS matches MAIL_SENDING_DOMAIN", async () => {
    setEnv({
      NODE_ENV: "production",
      MAIL_FROM_ADDRESS: "enquiries@kleibridal.com",
      MAIL_SENDING_DOMAIN: "kleibridal.com",
    });
    const { env } = await loadEnvModule();
    expect(env.NODE_ENV).toBe("production");
  });

  it("boots in production when MAIL_FROM_ADDRESS is a subdomain of MAIL_SENDING_DOMAIN", async () => {
    setEnv({
      NODE_ENV: "production",
      MAIL_FROM_ADDRESS: "enquiries@mail.kleibridal.com",
      MAIL_SENDING_DOMAIN: "kleibridal.com",
    });
    const { env } = await loadEnvModule();
    expect(env.MAIL_FROM_ADDRESS).toBe("enquiries@mail.kleibridal.com");
  });
});
