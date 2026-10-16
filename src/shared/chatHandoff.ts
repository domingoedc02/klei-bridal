/**
 * KBS-18 chat hand-offs. Pure: browser state is untrusted, so every value is
 * re-validated here and a failure means "no action", never a repaired value
 * (decision/kbs-18-hydrated-handoffs). Destinations are built from validated
 * settings only; the message is a fixed-order allowlist encoded exactly once.
 */
import { isIsoDate } from "@/shared/dates";
import type { ChatChannel } from "@/shared/schemas/chatChannel";

export interface ChatSettings {
  messengerPage: string | null;
  whatsappNumber: string | null;
  /** Retained for settings compatibility; KBS-18 does not emit Viber hand-offs. */
  viberNumber: string | null;
}

export interface HandoffInput {
  firstName: string;
  lastName: string;
  weddingDate: string;
  /** Trusted display-safe names only. UUIDs are never names. */
  gownNames: string[];
  shortLinkUrl: string | null;
  /** Hostname of the page; the short link must be same-site. */
  siteHostname: string;
  settings: ChatSettings;
}

export interface Handoff {
  channel: ChatChannel;
  href: string;
}

export interface Handoffs {
  shortLink: string;
  messenger: Handoff | null;
  whatsapp: Handoff | null;
  viber: Handoff | null;
}

const HANDLE = /^[A-Za-z0-9.]{5,50}$/;
const DIGITS = /^[1-9][0-9]{6,14}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const MAX_GOWN_NAMES = 50;

/** Bounded, non-empty, trimmed, no HTML delimiters, no control characters. */
export function isDisplaySafe(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= max &&
    !/[<>]/.test(value) &&
    !CONTROL.test(value)
  );
}

export function isSafeGownName(value: unknown): value is string {
  return isDisplaySafe(value, 100) && !UUID.test(value);
}

/** Same-site https `/e/<token>` URL with nothing else on it, or null. */
export function validShortLink(value: unknown, siteHostname: string): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  try {
    const url = new URL(value);
    const ok =
      url.protocol === "https:" &&
      url.hostname === siteHostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith("/e/") &&
      TOKEN.test(url.pathname.slice(3));
    return ok ? url.href : null;
  } catch {
    return null;
  }
}

/** The one prefilled message: first name, last name, gowns, date, link, in that order. */
export function buildMessage(
  input: Pick<HandoffInput, "firstName" | "lastName" | "weddingDate" | "gownNames">,
  shortLink: string,
): string {
  return [
    `Hello Klei Bridal Studio, my name is ${input.firstName} ${input.lastName}.`,
    `Gowns: ${input.gownNames.join(", ")}.`,
    `Wedding date: ${input.weddingDate}.`,
    `Enquiry: ${shortLink}`,
  ].join(" ");
}

export function buildHandoffs(input: HandoffInput): Handoffs | null {
  const { settings } = input;
  const shortLink = validShortLink(input.shortLinkUrl, input.siteHostname);
  if (
    !shortLink ||
    !isDisplaySafe(input.firstName, 100) ||
    !isDisplaySafe(input.lastName, 100) ||
    !isIsoDate(input.weddingDate) ||
    input.gownNames.length < 1 ||
    input.gownNames.length > MAX_GOWN_NAMES ||
    !input.gownNames.every(isSafeGownName)
  )
    return null;

  const text = encodeURIComponent(buildMessage(input, shortLink));
  const messenger: Handoff | null =
    settings.messengerPage && HANDLE.test(settings.messengerPage)
      ? { channel: "messenger", href: `https://m.me/${settings.messengerPage}` }
      : null;
  const whatsapp: Handoff | null =
    settings.whatsappNumber && DIGITS.test(settings.whatsappNumber)
      ? { channel: "whatsapp", href: `https://wa.me/${settings.whatsappNumber}?text=${text}` }
      : null;
  // KBS-18 scope: Messenger and WhatsApp only. Viber is deferred until its
  // business URL scheme and destination contract are approved.
  const viber: Handoff | null = null;
  if (!messenger && !whatsapp && !viber) return null;
  return { shortLink, messenger, whatsapp, viber };
}
