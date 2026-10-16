"use client";

import { useCallback } from "react";

export interface ConfirmationData {
  reference: string;
  short_link_url: string | null;
  first_name: string;
  last_name: string;
  wedding_date: string;
  gowns: string[];
  messenger_page: string | null;
  whatsapp_number: string | null;
  viber_number: string | null;
}

type Channel = "messenger" | "whatsapp" | "viber";

const SAFE_TEXT = /^(?!.*[\u0000-\u001f\u007f<>]).+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const HANDLE = /^[A-Za-z0-9._-]{1,100}$/u;
const PHONE = /^\d{7,15}$/u;
const TOKEN = /^[A-Za-z0-9_-]{8,200}$/u;

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && SAFE_TEXT.test(value);
}

function shortLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== window.location.origin) return null;
    if (url.search || url.hash) return null;
    const parts = url.pathname.split("/");
    const token = parts.length === 3 && parts[1] === "e" ? parts[2] : undefined;
    return token && TOKEN.test(token) ? url.href : null;
  } catch {
    return null;
  }
}

function channelUrl(shortLinkValue: string): string | null {
  const link = shortLink(shortLinkValue);
  if (!link) return null;
  const token = new URL(link).pathname.split("/")[2];
  return token ? `/e/${encodeURIComponent(token)}/channel` : null;
}

function recordChannel(shortLinkValue: string, channel: Channel) {
  const endpoint = channelUrl(shortLinkValue);
  if (!endpoint) return;
  const body = JSON.stringify({ channel });
  try {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon?.(endpoint, blob)) return;
  } catch {
    // Analytics must never block chat navigation.
  }
  try {
    void fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Analytics must never block chat navigation.
  }
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [, year, month, day] = value.match(DATE) ?? [];
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toISOString().slice(0, 10) === value;
}

function validGowns(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 20 &&
    value.every((gown) => boundedText(gown, 200) && !UUID.test(gown))
  );
}

function validShortLink(value: unknown): value is string {
  return shortLink(value) !== null;
}

function message(data: ConfirmationData, link: string) {
  return [
    `Hello Klei Bridal Studio, my name is ${data.first_name} ${data.last_name}.`,
    `Gowns: ${data.gowns.join(", ")}.`,
    `Wedding date: ${data.wedding_date}.`,
    `Enquiry: ${link}`,
  ].join(" ");
}

function destinations(data: ConfirmationData, link: string) {
  if (
    !boundedText(data.first_name, 100) ||
    !boundedText(data.last_name, 100) ||
    !validDate(data.wedding_date) ||
    !validGowns(data.gowns) ||
    !validShortLink(link)
  ) {
    return null;
  }
  const shareMessage = message(data, link);
  const messenger = HANDLE.test(data.messenger_page ?? "")
    ? new URL(`https://m.me/${data.messenger_page}`)
    : null;
  const whatsapp = PHONE.test(data.whatsapp_number ?? "")
    ? new URL(`https://wa.me/${data.whatsapp_number}`)
    : null;
  const viber = PHONE.test(data.viber_number ?? "") ? new URL("viber://chat") : null;
  if (viber) {
    viber.search = new URLSearchParams({ number: `+${data.viber_number}`, text: shareMessage }).toString();
  }
  if (whatsapp) whatsapp.search = new URLSearchParams({ text: shareMessage }).toString();
  return {
    link,
    messenger: messenger?.href ?? null,
    whatsapp: whatsapp?.href ?? null,
    viber: viber?.href ?? null,
  };
}

export default function ConfirmationActions({ data }: { data: ConfirmationData }) {
  const safeLink = shortLink(data.short_link_url);
  const safe = safeLink ? destinations(data, safeLink) : null;
  const messengerHref = safe?.messenger ?? null;
  const whatsappHref = safe?.whatsapp ?? null;
  const viberHref = safe?.viber ?? null;
  const secondaryHref = whatsappHref ?? viberHref;
  const secondaryChannel: Channel = whatsappHref ? "whatsapp" : "viber";

  const onMessenger = useCallback(() => {
    if (!safe) return;
    try {
      const write = navigator.clipboard?.writeText(safe.link);
      void write?.catch(() => undefined);
    } catch {
      // Visible selectable URL remains manual-copy fallback.
    }
    recordChannel(safe.link, "messenger");
  }, [safe]);

  const onSecondary = useCallback(() => {
    if (safe) recordChannel(safe.link, secondaryChannel);
  }, [safe, secondaryChannel]);

  if (!safe || (!messengerHref && !secondaryHref)) return null;
  return (
    <section className="chat-actions" aria-labelledby="chat-actions-title">
      <h2 id="chat-actions-title">Continue the conversation</h2>
      <p>Choose a chat app if you would like to follow up. Your enquiry is already complete.</p>
      <div className="chat-buttons">
        {messengerHref ? (
          <a href={messengerHref} onClick={onMessenger} className="chat-button">
            <strong>Messenger</strong>
            <span>Copy your link, then paste it into the chat.</span>
          </a>
        ) : null}
        {secondaryHref ? (
          <a href={secondaryHref} onClick={onSecondary} className="chat-button">
            <strong>{whatsappHref ? "WhatsApp" : "Viber"}</strong>
            <span>Your enquiry details will be ready to review before sending.</span>
          </a>
        ) : null}
      </div>
      {data.short_link_url ? (
        <p className="short-link">
          Your short link: <a href={data.short_link_url}>{data.short_link_url}</a>
        </p>
      ) : null}
      <style jsx>{`
        .chat-actions { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid #c9bca3; }
        .chat-actions h2 { margin: 0; font: 500 1.35rem Fraunces, Georgia, serif; }
        .chat-actions p { color: #5b544a; line-height: 1.55; }
        .chat-buttons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
        .chat-button { display: grid; gap: 0.35rem; min-height: 2.75rem; padding: 0.85rem 1rem; border: 1px solid #6e5420; color: #2b2825; text-decoration: none; }
        .chat-button span { color: #5b544a; font-size: 0.9rem; line-height: 1.4; }
        .chat-button:focus-visible, .short-link a:focus-visible { outline: 2px solid #6e5420; outline-offset: 2px; }
        .short-link { overflow-wrap: anywhere; user-select: text; }
        @media (max-width: 600px) { .chat-buttons { grid-template-columns: 1fr; } }
      `}</style>
    </section>
  );
}
