import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/config/env", () => ({
  env: { ALERT_EMAIL: "ops@example.test", STUDIO_ENQUIRY_EMAIL: "studio@example.test" },
}));
vi.mock("@/server/mail/send", () => ({ sendTransactionalEmail: vi.fn() }));

import { createLogger } from "@/server/observability/logger";
import { scrubEvent, scrubString, scrubValue } from "@/server/observability/scrub";
import { dispatchAlert, resetAlertSuppression } from "@/server/observability/alerts";

// KBS-33-1 AC: "a test error that deliberately includes a fake token/cookie
// arrives redacted" — proven against the exact beforeSend Sentry uses.
const SHORT_TOKEN = "Zk3pQ9vR2mX8nT4wL7yB1cD6fH0jK5sA9uE3gI2oP8q";
const SESSION = "S3ss10nT0k3nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CSRF = "csrfT0k3nBBBBBBBBBBBBBB";
const RESET = "r3s3tT0k3nCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const BRIDE = "ana.santos@example.test";
const IPS = ["198.51.100.23", "198.51.100.24", "198.51.100.25", "198.51.100.26", "198.51.100.27"];
const SECRETS = [
  SHORT_TOKEN,
  SESSION,
  CSRF,
  RESET,
  BRIDE,
  "re_live_abcdefgh123",
  "+63 917 123 4567",
  "203.0.113.9",
  ...IPS,
];

function hostileEvent() {
  return {
    message: `boom at https://kleibridal.test/e/${SHORT_TOKEN} for ${BRIDE}`,
    exception: {
      values: [
        {
          type: "Error",
          value: `fetch /e/${SHORT_TOKEN} failed; key re_live_abcdefgh123`,
          stacktrace: {
            frames: [{ filename: "app/e/[token]/page.tsx", vars: { token: SHORT_TOKEN } }],
          },
        },
      ],
    },
    request: {
      url: `https://kleibridal.test/e/${SHORT_TOKEN}?utm_source=facebook`,
      method: "POST",
      cookies: { kbs_session: SESSION, kbs_csrf: CSRF },
      headers: {
        cookie: `kbs_session=${SESSION}; kbs_csrf=${CSRF}`,
        authorization: "Bearer re_live_abcdefgh123",
        referer: `https://kleibridal.test/admin/reset-password?token=${RESET}`,
        "user-agent": "test",
        "x-csrf-token": CSRF,
        "x-forwarded-for": `${IPS[0]}, 10.0.0.2`,
        "x-real-ip": IPS[1],
        forwarded: `for=${IPS[2]};proto=https`,
        "cf-connecting-ip": IPS[3],
        "true-client-ip": IPS[4],
      },
      env: { REMOTE_ADDR: IPS[0] },
      data: { first_name: "Ana", email: BRIDE, contact_number: "+63 917 123 4567" },
      query_string: `token=${RESET}`,
    },
    user: { ip_address: "203.0.113.9" },
    breadcrumbs: [{ category: "fetch", data: { url: `/e/${SHORT_TOKEN}` } }],
    extra: { body: { message: "my dream gown", phone: "+63 917 123 4567" } },
  };
}

describe("scrubEvent (Sentry beforeSend)", () => {
  it("strips cookies, enquiry bodies, /e/* tokens, reset tokens, mail keys and bride PII", () => {
    const out = JSON.stringify(scrubEvent(hostileEvent()));
    for (const secret of SECRETS) expect(out).not.toContain(secret);
    expect(out).not.toContain("203.0.113.9");
    expect(out).not.toContain("my dream gown");
    // Still useful for diagnosis:
    expect(out).toContain("/e/[redacted]");
    expect(out).toContain("utm_source=facebook");
    expect(out).toContain('"method":"POST"');
  });

  it("does not mutate its input", () => {
    const event = hostileEvent();
    scrubEvent(event);
    expect(event.request.cookies.kbs_session).toBe(SESSION);
  });

  it("serialises Error objects without leaking their message", () => {
    const out = JSON.stringify(scrubValue({ err: new Error(`no row for /e/${SHORT_TOKEN}`) }));
    expect(out).not.toContain(SHORT_TOKEN);
    expect(out).toContain('"type":"Error"');
  });

  it("redacts reset tokens in every common URL spelling", () => {
    for (const value of [
      "/admin/reset-password?token=" + RESET,
      "?token=" + RESET,
      "https://kleibridal.test/admin/reset-password?reset_token=" + RESET,
    ]) {
      expect(scrubString(value)).not.toContain(RESET);
      expect(scrubString(value)).toContain("[redacted]");
    }
  });

  it("leaves a plain gown path alone", () => {
    expect(scrubString("/gowns/aria-a-line")).toBe("/gowns/aria-a-line");
  });
});

describe("logger", () => {
  it("writes JSON with secrets scrubbed from fields and message", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = createLogger(sink, "info");
    log.error(
      {
        request_id: "req-1",
        req: { headers: { cookie: `kbs_session=${SESSION}`, authorization: "Bearer x" } },
        email: BRIDE,
        err: new Error(`lookup /e/${SHORT_TOKEN} failed`),
      },
      `failed for ${BRIDE} at /admin/reset-password?token=${RESET}`,
    );
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ level: "error", service: "kbs-web", request_id: "req-1" });
    for (const secret of SECRETS) expect(lines[0]).not.toContain(secret);
  });
});

describe("dispatchAlert", () => {
  it("sends to ALERT_EMAIL, scrubbed, and suppresses a repeat inside 15 minutes", async () => {
    resetAlertSuppression();
    const send = vi.fn().mockResolvedValue(undefined);
    let t = 1_000_000;
    const alert = {
      key: "mail.studio_bounce",
      severity: "critical" as const,
      summary: "Studio enquiry inbox bounced",
      detail: [`bounced: ${BRIDE}`, "every enquiry from now on is arriving nowhere"],
    };
    expect(await dispatchAlert(alert, { send, now: () => t })).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const message = send.mock.calls[0]![0];
    expect(message.to).toBe("ops@example.test");
    expect(message.subject).toBe("[KBS CRITICAL] Studio enquiry inbox bounced");
    expect(message.text).not.toContain(BRIDE);

    t += 60_000;
    expect(await dispatchAlert(alert, { send, now: () => t })).toBe(false);
    t += 15 * 60_000;
    expect(await dispatchAlert(alert, { send, now: () => t })).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never throws, and retries next time, when the send fails", async () => {
    resetAlertSuppression();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValue(undefined);
    const alert = { key: "x", severity: "warning" as const, summary: "s", detail: [] };
    expect(await dispatchAlert(alert, { send, now: () => 1 })).toBe(false);
    expect(await dispatchAlert(alert, { send, now: () => 2 })).toBe(true);
  });

  it("reports undeliverable without ALERT_EMAIL instead of sending nowhere", async () => {
    resetAlertSuppression();
    const send = vi.fn();
    const alert = { key: "y", severity: "warning" as const, summary: "s", detail: [] };
    expect(await dispatchAlert(alert, { send, to: undefined })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
