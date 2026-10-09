import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the standalone production server — the same
// `server.js` the Dockerfile ships (KBS-7) — never `next dev` (KBS-31-1).
// Run `pnpm build` first.
//
// Both review widths are projects from day one: the client made phone and
// laptop co-equal, and a width added later is a width nobody runs.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

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
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "laptop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    // The standalone bundle omits static assets; copy them in as the
    // Dockerfile does, then boot it.
    command:
      "cp -R public .next/standalone/ && cp -R .next/static .next/standalone/.next/ && " +
      `HOSTNAME=127.0.0.1 PORT=${PORT} node .next/standalone/server.js`,
    url: baseURL,
    // Same-origin check compares Origin to SITE_URL; real-API specs post
    // from baseURL, so the server must agree on what "same origin" is.
    env: { SITE_URL: baseURL },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
