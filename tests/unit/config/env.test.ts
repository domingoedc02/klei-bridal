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
    // Clear the defaulted variables too, so an ambient value (CI sets
    // MAIL_DRY_RUN=true) cannot mask the default being asserted.
    setEnv({ NODE_ENV: "development", MAIL_DRY_RUN: undefined, STUDIO_TIMEZONE: undefined });
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

  it("refuses to boot when ALERT_EMAIL is one of STUDIO_ENQUIRY_EMAIL (any case, any list position)", async () => {
    setEnv({
      STUDIO_ENQUIRY_EMAIL: "owner@kleibridal.com, studio@kleibridal.com",
      ALERT_EMAIL: "Studio@KleiBridal.com",
    });
    await expect(loadEnvModule()).rejects.toThrow(/ALERT_EMAIL .* STUDIO_ENQUIRY_EMAIL/);
  });

  it("boots when ALERT_EMAIL is a separate inbox", async () => {
    setEnv({ ALERT_EMAIL: "alerts@kleibridal.com" });
    const { env } = await loadEnvModule();
    expect(env.ALERT_EMAIL).toBe("alerts@kleibridal.com");
  });

  it.each([
    ["the same path", "./.data/images", "./.data/images"],
    ["the same path spelled differently", "/data/media/originals", "/data/media/x/../originals/"],
    ["the cache inside originals", "/data/media", "/data/media/derivatives"],
    ["the cache in a child dir named ..cache", "/data/media", "/data/media/..cache"],
    ["originals inside the cache", "/data/media/derivatives/originals", "/data/media/derivatives"],
  ])("refuses to boot when the image paths overlap: %s", async (_label, originals, cache) => {
    setEnv({ IMAGE_ORIGINALS_PATH: originals, IMAGE_CACHE_PATH: cache });
    await expect(loadEnvModule()).rejects.toThrow(/IMAGE_ORIGINALS_PATH .* overlap/);
  });

  it("boots when the image paths are sibling directories, even with a shared name prefix", async () => {
    setEnv({ IMAGE_ORIGINALS_PATH: "/data/media/orig", IMAGE_CACHE_PATH: "/data/media/original" });
    const { env } = await loadEnvModule();
    expect(env.IMAGE_CACHE_PATH).toBe("/data/media/original");
  });
});
