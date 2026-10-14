import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`public catalogue stays per-request at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const first = await context.newPage();
    const firstResponse = await first.goto("/gowns");
    expect(firstResponse?.status()).toBe(200);
    expect(firstResponse?.headers()["cache-control"]).not.toMatch(
      /public|s-maxage|stale-while-revalidate/i,
    );
    expect(firstResponse?.headers()["set-cookie"]).toContain("kbs_csrf=");
    const firstCsp = firstResponse?.headers()["content-security-policy-report-only"];
    expect(firstCsp).toMatch(/nonce-[A-Za-z0-9_-]+/);

    const second = await context.newPage();
    const secondResponse = await second.goto("/gowns");
    expect(secondResponse?.status()).toBe(200);
    expect(secondResponse?.headers()["cache-control"]).not.toMatch(
      /public|s-maxage|stale-while-revalidate/i,
    );
    const secondCsp = secondResponse?.headers()["content-security-policy-report-only"];
    expect(secondCsp).toMatch(/nonce-[A-Za-z0-9_-]+/);
    expect(secondCsp).not.toBe(firstCsp);

    await context.close();
  });
}

test("invalid catalogue query returns INVALID_QUERY without public caching", async ({
  request,
}) => {
  const response = await request.get(`/gowns?q=${"x".repeat(81)}`);
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "INVALID_QUERY" } });
  expect(response.headers()["cache-control"]).not.toMatch(
    /public|s-maxage|stale-while-revalidate/i,
  );
});
