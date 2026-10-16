import { describe, expect, it } from "vitest";

import { buildHandoffs, type HandoffInput } from "@/shared/chatHandoff";

const TOKEN = "a".repeat(43);
const base: HandoffInput = {
  firstName: "Maria",
  lastName: "O'Neil & Santos",
  weddingDate: "2027-05-14",
  gownNames: ["Aria #1", "Élise — 💍"],
  shortLinkUrl: `https://klei.test/e/${TOKEN}`,
  siteHostname: "klei.test",
  settings: {
    messengerPage: "kleibridal",
    whatsappNumber: "639171234567",
    viberNumber: "639171234567",
  },
};
const build = (patch: Partial<HandoffInput>) => buildHandoffs({ ...base, ...patch });

describe("buildHandoffs", () => {
  it("builds destinations from validated settings", () => {
    const h = build({})!;
    expect(h.messenger!.href).toBe("https://m.me/kleibridal");
    expect(h.whatsapp!.href.startsWith("https://wa.me/639171234567?text=")).toBe(true);
    expect(h.viber!.href.startsWith("viber://chat?number=%2B639171234567&text=")).toBe(true);
  });

  it("encodes the message once and round-trips special characters", () => {
    const h = build({})!;
    const url = new URL(h.whatsapp!.href);
    const text = url.searchParams.get("text")!;
    expect(text).toBe(
      `Hello Klei Bridal Studio, my name is Maria O'Neil & Santos. Gowns: Aria #1, Élise — 💍. Wedding date: 2027-05-14. Enquiry: ${base.shortLinkUrl}`,
    );
    expect(url.hash).toBe("");
    expect(h.whatsapp!.href).not.toMatch(/%25/);
    expect(new URL(h.viber!.href).searchParams.get("text")).toBe(text);
  });

  it("never carries fields outside the allowlist", () => {
    const text = decodeURIComponent(build({})!.whatsapp!.href);
    for (const forbidden of ["@", "+63", "csrf", "session"]) expect(text).not.toContain(forbidden);
  });

  it.each([
    ["no names", { gownNames: [] }],
    ["uuid as name", { gownNames: ["3f2b8c1e-5d4a-4b6e-9f10-0a1b2c3d4e5f"] }],
    ["html in name", { gownNames: ["<b>x</b>"] }],
    ["control char name", { gownNames: ["a\nb"] }],
    ["long first name", { firstName: "x".repeat(101) }],
    ["bad date", { weddingDate: "2027-02-30" }],
    ["http short link", { shortLinkUrl: `http://klei.test/e/${TOKEN}` }],
    ["foreign host short link", { shortLinkUrl: `https://evil.test/e/${TOKEN}` }],
    ["short link with query", { shortLinkUrl: `https://klei.test/e/${TOKEN}?x=1` }],
    ["short link bad token", { shortLinkUrl: "https://klei.test/e/short" }],
    ["no short link", { shortLinkUrl: null }],
  ])("omits all actions: %s", (_name, patch) => {
    expect(build(patch)).toBeNull();
  });

  it.each(["evil.com/x", "a b", "javascript:alert(1)", "data:text/html,x", "page?x=1", "ab", ""])(
    "rejects malformed messenger handle %j",
    (messengerPage) => {
      expect(build({ settings: { ...base.settings, messengerPage } })!.messenger).toBeNull();
    },
  );

  it.each(["+639171234567", "0917", "639171234567&x=1", "javascript:1", "", "63917 123"])(
    "rejects malformed number %j",
    (n) => {
      const h = build({ settings: { ...base.settings, whatsappNumber: n, viberNumber: n } })!;
      expect(h.whatsapp).toBeNull();
      expect(h.viber).toBeNull();
    },
  );

  it("returns null when no destination is configured", () => {
    expect(
      build({ settings: { messengerPage: null, whatsappNumber: null, viberNumber: null } }),
    ).toBeNull();
  });
});
