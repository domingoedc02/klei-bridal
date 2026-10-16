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

function channelUrl(shortLink: string) {
  try {
    const url = new URL(shortLink, window.location.origin);
    const token = url.pathname.split("/").filter(Boolean).at(-1);
    return token ? `/e/${encodeURIComponent(token)}/channel` : null;
  } catch {
    return null;
  }
}

function recordChannel(shortLink: string, channel: "messenger" | "whatsapp" | "viber") {
  const endpoint = channelUrl(shortLink);
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

function message(data: ConfirmationData) {
  const gowns = data.gowns.length ? data.gowns.join(", ") : "no gown selected yet";
  return [
    `Hello Klei Bridal Studio, my name is ${data.first_name} ${data.last_name}.`,
    `Gowns: ${gowns}.`,
    `Wedding date: ${data.wedding_date}.`,
    `Enquiry: ${data.short_link_url ?? data.reference}`,
  ].join(" ");
}

export default function ConfirmationActions({ data }: { data: ConfirmationData }) {
  const shareMessage = message(data);
  const messengerHref = data.messenger_page
    ? `https://m.me/${encodeURIComponent(data.messenger_page)}`
    : null;
  const whatsappHref = data.whatsapp_number
    ? `https://wa.me/${data.whatsapp_number}?text=${encodeURIComponent(shareMessage)}`
    : null;
  const viberHref = data.viber_number
    ? `viber://chat?number=%2B${data.viber_number}&text=${encodeURIComponent(shareMessage)}`
    : null;
  const secondaryHref = whatsappHref ?? viberHref;
  const secondaryChannel = whatsappHref ? "whatsapp" : "viber";

  const onMessenger = useCallback(() => {
    if (!data.short_link_url) return;
    try {
      const write = navigator.clipboard?.writeText(data.short_link_url);
      void write?.catch(() => undefined);
    } catch {
      // Visible selectable URL remains manual-copy fallback.
    }
    recordChannel(data.short_link_url, "messenger");
  }, [data.short_link_url]);

  const onSecondary = useCallback(() => {
    if (data.short_link_url) recordChannel(data.short_link_url, secondaryChannel);
  }, [data.short_link_url, secondaryChannel]);

  if (!messengerHref && !secondaryHref) return null;
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
