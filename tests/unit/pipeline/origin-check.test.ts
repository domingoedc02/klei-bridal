import { describe, expect, it } from "vitest";

import { env } from "@/config/env";
import { requireChannelOrigin } from "@/server/pipeline/origin-check";

const origin = new URL(env.SITE_URL).origin;

function request(headers: Record<string, string> = {}) {
  return new Request(`${origin}/e/${"A".repeat(43)}/channel`, {
    method: "POST",
    headers,
  });
}

describe("requireChannelOrigin", () => {
  it("accepts same-origin beacon metadata", () => {
    expect(() =>
      requireChannelOrigin(
        request({ origin, "sec-fetch-site": "same-origin" }),
      ),
    ).not.toThrow();
  });

  it.each([
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    { origin, "sec-fetch-site": "same-site" },
    { origin: "null", "sec-fetch-site": "same-origin" },
  ])("rejects forged metadata: $origin / $sec-fetch-site", (headers) => {
    expect(() => requireChannelOrigin(request(headers))).toThrowError(
      "Cross-site request refused.",
    );
  });

  it("rejects missing Origin", () => {
    expect(() => requireChannelOrigin(request({ "sec-fetch-site": "same-origin" }))).toThrowError(
      "Origin is required.",
    );
  });
});
