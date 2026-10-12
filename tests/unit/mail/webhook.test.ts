import { createHmac } from "node:crypto";
import type Redis from "iovalkey";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { SECRET, send } = vi.hoisted(() => ({
  SECRET: `whsec_${Buffer.from("test-signing-key-32-bytes-long!!").toString("base64")}`,
  send: vi.fn(async (message: unknown) => void message),
}));
vi.mock("@/config/env", () => ({
  env: {
    MAIL_WEBHOOK_SIGNING_SECRET: SECRET,
    STUDIO_ENQUIRY_EMAIL: "studio@kleibridal.com, owner@kleibridal.com",
    ALERT_EMAIL: "ops@example.test",
    MAIL_DRY_RUN: true,
    SESSION_SECRET: "a".repeat(32),
  },
}));
vi.mock("@/server/mail/send", () => ({ sendTransactionalEmail: send }));

import { mailWebhookHandler } from "../../../app/api/webhooks/mail/route";
import {
  createValkeyMailStats,
  handleMailEvent,
  verifySignature,
  type MailCounts,
  type MailStats,
} from "../../../src/server/mail/webhook";
import { resetAlertSuppression, type Alert } from "../../../src/server/observability/alerts";
import { logger } from "../../../src/server/observability/logger";
import { withPipeline } from "../../../src/server/pipeline";
import { budgets } from "../../../src/server/ratelimit/budgets";

const NOW = 1_760_000_000_000;
const BRIDE = "ana.santos@example.test";

function sign(body: string, id = "msg_1", ts = String(NOW / 1000), secret = SECRET) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}

function fixedStats(counts: MailCounts): MailStats & { calls: string[] } {
  const calls: string[] = [];
  return { calls, record: async (kind, id) => (calls.push(`${kind}:${id}`), counts) };
}

function post(body: string, headers: Record<string, string>, stats: MailStats) {
  const route = withPipeline((r: NextRequest) => mailWebhookHandler(r, { stats, now: () => NOW }), {
    auth: "public",
    csrf: false,
    rateLimit: budgets.mailWebhook,
    rateLimitStore: () => ({ hit: async () => ({ count: 1, ttlSec: 59 }) }),
  });
  return route(
    new NextRequest("http://localhost/api/webhooks/mail", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    }),
    {},
  );
}

const bounced = (to: string) =>
  JSON.stringify({
    type: "email.bounced",
    data: { email_id: "e-1", to: [to], bounce: { type: "Permanent", subType: "General" } },
  });

beforeEach(() => {
  send.mockClear();
  resetAlertSuppression();
});

describe("verifySignature (Svix scheme)", () => {
  const body = '{"type":"email.sent"}';
  const check = (h: Record<string, string>, now = NOW) =>
    verifySignature(SECRET, new Headers(h), body, now);

  it("accepts a valid v1 signature, including when it is not the first entry", () => {
    expect(check(sign(body))).toBe("ok");
    const h = sign(body);
    expect(check({ ...h, "svix-signature": `v1,AAAA v2,zzz ${h["svix-signature"]}` })).toBe("ok");
  });

  it("rejects a tampered body, a wrong secret, a stale or replayed timestamp, missing headers", () => {
    expect(verifySignature(SECRET, new Headers(sign(body)), body + " ", NOW)).toBe("bad_signature");
    const other = `whsec_${Buffer.from("another-key").toString("base64")}`;
    expect(check(sign(body, "msg_1", String(NOW / 1000), other))).toBe("bad_signature");
    expect(check(sign(body), NOW + 6 * 60 * 1000)).toBe("stale_timestamp");
    expect(check({ ...sign(body), "svix-timestamp": "1e9" })).toBe("stale_timestamp");
    expect(check({ "svix-id": "x", "svix-timestamp": "1" })).toBe("missing_headers");
  });
});

describe("POST /api/webhooks/mail", () => {
  it("forged signature: 401, no alert, attempt logged, body never parsed", async () => {
    const warn = vi.spyOn(logger, "warn");
    const stats = fixedStats({ failed24h: 9, failed7d: 9, sent7d: 9 });
    const headers = { ...sign(bounced("studio@kleibridal.com")), "svix-signature": "v1,Zm9yZ2Vk" };
    const res = await post(bounced("studio@kleibridal.com"), headers, stats);
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    expect(stats.calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mail_webhook_rejected", reason: "bad_signature" }),
      "mail_webhook_rejected",
    );
    warn.mockRestore();
  });

  it("studio-address bounce: alerts on the first occurrence, 204", async () => {
    const body = bounced("Owner@KleiBridal.com");
    const res = await post(body, sign(body), fixedStats({ failed24h: 0, failed7d: 0, sent7d: 0 }));
    expect(res.status).toBe(204);
    expect(send).toHaveBeenCalledTimes(1);
    const mail = (
      send.mock.calls[0] as unknown as [{ to: string; subject: string; text: string }]
    )[0];
    expect(mail.to).toBe("ops@example.test");
    expect(mail.subject).toContain("[KBS CRITICAL] Studio enquiry inbox bounced");
    expect(mail.text).not.toMatch(/kleibridal\.com/i);
  });

  it("malformed JSON with a valid signature is a 400", async () => {
    const res = await post(
      "{nope",
      sign("{nope"),
      fixedStats({ failed24h: 0, failed7d: 0, sent7d: 0 }),
    );
    expect(res.status).toBe(400);
  });
});

describe("handleMailEvent thresholds", () => {
  const run = async (type: string, counts: MailCounts, to = BRIDE) => {
    const alerts: Alert[] = [];
    const stats = fixedStats(counts);
    await handleMailEvent({ type, data: { email_id: "e", to: [to] } }, "msg_9", {
      studio: ["studio@kleibridal.com"],
      alertInbox: "ops@example.test",
      stats,
      alert: async (a) => (alerts.push(a), true),
      now: () => NOW,
    });
    return { alerts, calls: stats.calls };
  };

  it("counts sends, alerts nothing", async () => {
    expect(await run("email.sent", { failed24h: 0, failed7d: 0, sent7d: 1 })).toEqual({
      alerts: [],
      calls: ["sent:msg_9"],
    });
  });

  it("stays quiet at or under 5% over 7 days and under 3 in 24h", async () => {
    expect((await run("email.bounced", { failed24h: 2, failed7d: 5, sent7d: 100 })).alerts).toEqual(
      [],
    );
  });

  it("alerts above 5% over 7 days, or at 3 in 24h, with counts and no addresses", async () => {
    const rate = await run("email.complained", { failed24h: 1, failed7d: 6, sent7d: 100 });
    const burst = await run("email.bounced", { failed24h: 3, failed7d: 3, sent7d: 1000 });
    for (const { alerts } of [rate, burst]) {
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.key).toBe("mail.bride_bounce_rate");
      expect(JSON.stringify(alerts[0])).not.toContain("@");
    }
    expect(rate.alerts[0]!.detail[0]).toContain("6 bounced/complained of 100 sent (6.0%");
  });

  it("does not alert about the alert inbox itself, and never counts studio mail", async () => {
    expect(
      await run("email.bounced", { failed24h: 9, failed7d: 9, sent7d: 9 }, "ops@example.test"),
    ).toEqual({
      alerts: [],
      calls: [],
    });
    expect(
      (await run("email.sent", { failed24h: 0, failed7d: 0, sent7d: 0 }, "studio@kleibridal.com"))
        .calls,
    ).toEqual([]);
  });
});

describe("Valkey mail stats", () => {
  it("adds by event id, trims both sets to 7 days, and reads the three counts in one MULTI", async () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["zadd", "zremrangebyscore", "pexpire", "zcount"])
      chain[m] = vi.fn(() => chain);
    chain.exec = vi.fn(async () => [
      [null, 1],
      [null, 0],
      [null, 0],
      [null, 1],
      [null, 2],
      [null, 4],
      [null, 50],
    ]);
    const stats = createValkeyMailStats({ multi: () => chain } as unknown as Redis);
    expect(await stats.record("failed", "msg_1", NOW)).toEqual({
      failed24h: 2,
      failed7d: 4,
      sent7d: 50,
    });
    expect(chain.zadd).toHaveBeenCalledWith("mail:failed", NOW, "msg_1");
    chain.exec = vi.fn(async () => [[new Error("OOM"), null]]);
    await expect(stats.record("sent", "m", NOW)).rejects.toThrow("OOM");
  });
});
