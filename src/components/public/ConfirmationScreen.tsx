"use client";

import Link from "next/link";
import { useMemo } from "react";

import { buildHandoffs, validShortLink, type ChatSettings, type Handoff } from "@/shared/chatHandoff";
import { ENQUIRY_REFERENCE_PATTERN } from "@/shared/enquiryForm";
import type { ChatChannel } from "@/shared/schemas/chatChannel";

export interface ConfirmationData {
  reference: string | null;
  shortLinkUrl: string | null;
  firstName: string;
  lastName: string;
  weddingDate: string;
  /** Trusted display names, or null when any selected gown has none. */
  gownNames: string[] | null;
  settings: ChatSettings;
}

/** Fire-and-forget: never awaited, never throws, never delays navigation. */
function recordChannel(shortLink: string, channel: ChatChannel) {
  try {
    const url = `/e/${new URL(shortLink).pathname.slice(3)}/channel`;
    const body = JSON.stringify({ channel });
    const beaconed =
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    if (!beaconed)
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => undefined);
  } catch {
    /* analytics only */
  }
}

export default function ConfirmationScreen({ data }: { data: ConfirmationData }) {
  const reference =
    data.reference && ENQUIRY_REFERENCE_PATTERN.test(data.reference) ? data.reference : null;
  const handoffs = useMemo(
    () =>
      data.gownNames
        ? buildHandoffs({
            firstName: data.firstName,
            lastName: data.lastName,
            weddingDate: data.weddingDate,
            gownNames: data.gownNames,
            shortLinkUrl: data.shortLinkUrl,
            siteHostname: window.location.hostname,
            settings: data.settings,
          })
        : null,
    [data],
  );
  // Shown as text whenever it passes the same-site check, even with no chat actions.
  const shortLink = validShortLink(data.shortLinkUrl, window.location.hostname);

  function onMessenger() {
    if (!shortLink) return;
    try {
      // Synchronous inside the activation; failure is silent (manual copy stays visible).
      void navigator.clipboard.writeText(shortLink).catch(() => undefined);
    } catch {
      /* clipboard unavailable */
    }
    recordChannel(shortLink, "messenger");
  }

  function action(handoff: Handoff | null, label: string, hint: string, external: boolean) {
    if (!handoff || !shortLink) return null;
    return (
      <a
        className="chat-button"
        href={handoff.href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        onClick={() =>
          handoff.channel === "messenger"
            ? onMessenger()
            : recordChannel(shortLink, handoff.channel)
        }
      >
        <strong>{label}</strong>
        <span>{hint}</span>
      </a>
    );
  }

  const buttons = handoffs && [
    action(
      handoffs.messenger,
      "Messenger",
      "We copy your link. Paste it into the chat and send.",
      true,
    ),
    action(
      handoffs.whatsapp,
      "WhatsApp",
      "Opens WhatsApp with your details ready. Review, then send.",
      true,
    ),
    action(
      handoffs.viber,
      "Viber",
      "Opens Viber with your details ready. Review, then send.",
      false,
    ),
  ];

  return (
    <section className="enquiry-success" aria-live="polite">
      <h1>Thank you</h1>
      <p>Your enquiry was sent. We will be in touch soon.</p>
      {reference ? (
        <p>
          Your reference is <strong className="selectable">{reference}</strong>.
        </p>
      ) : null}
      {shortLink ? (
        <p>
          Your short link: <span className="selectable">{shortLink}</span>
        </p>
      ) : null}
      <p>
        {shortLink
          ? "A copy of your enquiry, including your reference and short link, was also emailed to you."
          : "A copy of your enquiry, including your reference, was also emailed to you."}{" "}
        It is your backup, whether or not you message us.
      </p>
      {buttons?.some(Boolean) ? (
        <div className="chat">
          <h2>Want to message us as well?</h2>
          <div className="chat-buttons">{buttons}</div>
        </div>
      ) : null}
      <p>
        <Link href="/gowns">Keep browsing gowns</Link>
      </p>
      <style jsx>{`
        .enquiry-success {
          max-width: 52rem;
          margin: 0 auto;
          padding: 2rem 1.5rem;
          color: #2b2825;
        }
        h1,
        h2 {
          font-family: Fraunces, Georgia, serif;
          font-weight: 500;
        }
        p {
          color: #5b544a;
          line-height: 1.55;
        }
        .selectable {
          user-select: text;
          overflow-wrap: anywhere;
          color: #2b2825;
        }
        .chat {
          margin-top: 1.5rem;
          border-top: 1px solid #c9bca3;
          padding-top: 1rem;
        }
        .chat-buttons {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
          gap: 0.75rem;
        }
        .chat-buttons :global(.chat-button) {
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 0.25rem;
          min-height: 2.75rem;
          padding: 0.75rem 1rem;
          border: 1px solid #6e5420;
          color: #2b2825;
          text-decoration: none;
        }
        .chat-buttons :global(.chat-button span) {
          color: #5b544a;
          font-size: 0.9rem;
          line-height: 1.4;
        }
        .chat-buttons :global(.chat-button:focus-visible) {
          outline: 2px solid #6e5420;
          outline-offset: 2px;
        }
        @media (max-width: 600px) {
          .enquiry-success {
            padding: 1.5rem 1rem;
          }
        }
      `}</style>
    </section>
  );
}
