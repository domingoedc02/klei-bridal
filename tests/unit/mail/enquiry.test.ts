import { describe, expect, it, vi } from "vitest";

vi.mock("@/config/env", () => ({
  env: {
    MAIL_DRY_RUN: false,
    MAIL_PROVIDER_API_KEY: "re_test_key",
    MAIL_FROM_ADDRESS: "enquiries@kleibridal.com",
    MAIL_FROM_NAME: "Klei Bridal Studio",
    STUDIO_ENQUIRY_EMAIL: "studio@kleibridal.com",
  },
}));

import {
  brideEnquiryEmail,
  dispatchEnquiryEmails,
  resendTransport,
  studioEnquiryEmail,
  type EnquiryEmailData,
  type MailMessage,
} from "@/server/mail/enquiry";

const data: EnquiryEmailData = {
  enquiryId: "00000000-0000-0000-0000-000000000001",
  reference: "KB-ABCD-EFGH",
  shortLinkUrl: "http://localhost:3000/e/abc",
  firstName: "Ana <script>",
  lastName: "Santos & Co",
  contactNumber: "+63 917 123 4567",
  email: "ana@example.test",
  weddingDate: "2030-06-12",
  message: "Hello <b>studio</b>\nSecond line",
  leadTimeBand: "comfortable",
  notice: "",
  gowns: [{ name: "Gown & <Pearl>", priceMinor: 8500000, priceStatus: "priced", currency: "PHP" }],
};

function transport(send: MailMessage[] = []) {
  return {
    send: vi.fn(async (message: MailMessage) => {
      send.push(message);
      return { requestId: "mail-1" };
    }),
  };
}

describe("enquiry mail templates", () => {
  it("escapes user content in HTML and text and keeps the bride copy separate", () => {
    const studio = studioEnquiryEmail(data);
    const bride = brideEnquiryEmail(data);

    expect(studio.html).toContain("Ana &lt;script&gt;");
    expect(studio.html).toContain("Gown &amp; &lt;Pearl&gt;");
    expect(studio.html).not.toContain("<script>");
    expect(studio.text).toContain("Hello &lt;b&gt;studio&lt;/b&gt;");
    expect(bride.html).not.toContain("studio@kleibridal.com");
    expect(bride.text).toContain("Your short link:");
    expect(studio.replyTo).toBe(data.email);
  });

  it("bride copy omits internal triage fields; studio copy keeps them", () => {
    const withNotice = { ...data, leadTimeBand: "rush" as const, notice: "Rush or in-stock" };
    const bride = brideEnquiryEmail(withNotice);
    const studio = studioEnquiryEmail(withNotice);
    for (const body of [bride.html, bride.text]) {
      expect(body).not.toContain("Lead-time band");
      expect(body).not.toContain("Notice shown");
      expect(body).not.toContain("Rush or in-stock");
    }
    expect(studio.text).toContain("Lead-time band: rush");
    expect(studio.text).toContain("Notice shown: Rush or in-stock");
  });

  it("states no gown selected", () => {
    const message = brideEnquiryEmail({ ...data, gowns: [] });
    expect(message.html).toContain("No gown selected.");
    expect(message.text).toContain("No gown selected.");
  });

  it("posts Resend payload without putting user content in From", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      requests.push(init!);
      return new Response(JSON.stringify({ id: "re_123" }), { status: 200 });
    });
    const send = await resendTransport(fetchImpl).send(studioEnquiryEmail(data));
    const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
    expect(send).toEqual({ requestId: "re_123" });
    expect(body.from).toBe("Klei Bridal Studio <enquiries@kleibridal.com>");
    expect(body.reply_to).toBe(data.email);
  });
});

describe("enquiry mail delivery", () => {
  it("sends both templates and marks both statuses sent", async () => {
    const messages: MailMessage[] = [];
    const update = vi.fn(() => ({
      set: () => ({ where: vi.fn(async () => undefined) }),
    }));
    const db = { update } as never;
    await dispatchEnquiryEmails(data, { transport: transport(messages), db });
    expect(messages).toHaveLength(2);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("retries each failed delivery three times, then marks failed and logs only id", async () => {
    const send = vi.fn(async () => {
      throw new Error("provider secret detail");
    });
    const update = vi.fn(() => ({
      set: () => ({ where: vi.fn(async () => undefined) }),
    }));
    const log = vi.fn();
    const sleep = vi.fn(async () => undefined);
    await dispatchEnquiryEmails(data, {
      transport: { send },
      db: { update } as never,
      sleep,
      log,
    });
    expect(send).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("provider secret detail");
    expect(JSON.stringify(log.mock.calls)).toContain(data.enquiryId);
  });
});
