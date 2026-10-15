import { resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the standalone production server — the same
// `server.js` the Dockerfile ships (KBS-7) — never `next dev` (KBS-31-1).
// Run `pnpm build` first.
//
// Both review widths are projects from day one: the client made phone and
// laptop co-equal, and a width added later is a width nobody runs.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;
const gownImageProjects = [
  ["phone-dpr1", 390, 1],
  ["phone-dpr2", 390, 2],
  ["phone-dpr3", 390, 3],
  ["laptop-dpr1", 1280, 1],
  ["laptop-dpr2", 1280, 2],
  ["laptop-dpr3", 1280, 3],
] as const;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "phone",
      testIgnore: /gown-images\.spec\.ts/,
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "laptop",
      testIgnore: /gown-images\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    ...gownImageProjects.map(([name, width, deviceScaleFactor]) => ({
      name,
      testMatch: /gown-images\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width, height: width === 390 ? 844 : 800 },
        deviceScaleFactor,
      },
    })),
  ],
  webServer: {
    // The standalone bundle omits static assets and the external media cache.
    // Copy both into runtime paths before booting it.
    command:
      `cp -R public .next/standalone/ && cp -R .next/static .next/standalone/.next/ && ` +
      `mkdir -p .next/standalone/.data/images && ` +
      `cp -R .data/images/derivatives .next/standalone/.data/images/derivatives && ` +
      `IMAGE_CACHE_PATH=${resolve(".next/standalone/.data/images/derivatives")} ` +
      `HOSTNAME=127.0.0.1 PORT=${PORT} node .next/standalone/server.js`,
    url: baseURL,
    // Same-origin check compares Origin to SITE_URL; real-API specs post
    // from baseURL, so the server must agree on what "same origin" is.
    env: { SITE_URL: baseURL },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
