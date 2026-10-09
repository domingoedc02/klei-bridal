import { z } from "zod";

import { env } from "@/config/env";
import type { Database } from "@/server/db/client";
import { enquiries } from "@/server/db/schema";
import { eq } from "drizzle-orm";

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 500];

export interface EnquiryEmailGown {
  name: string;
  priceMinor: number | null;
  priceStatus: string;
  currency: string;
}

export interface EnquiryEmailData {
  enquiryId: string;
  reference: string;
  shortLinkUrl: string;
  firstName: string;
  lastName: string;
  contactNumber: string;
  email: string;
  weddingDate: string;
  message: string | null;
  leadTimeBand: string;
  notice: string;
  gowns: EnquiryEmailGown[];
}

export interface MailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<{ requestId?: string }>;
}

export interface EnquiryMailDeps {
  transport?: MailTransport;
  db?: Database;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string, data: { enquiryId: string; requestId?: string }) => void;
}

class MailProviderError extends Error {
  constructor(
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

const html = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

// Plain text mail still needs delimiter/control sanitisation. Entity escaping
// keeps user text from becoming markup when a provider/client renders it.
const text = (value: string): string =>
  value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const displayPrice = (gown: EnquiryEmailGown): string =>
  gown.priceStatus === "priced" && gown.priceMinor !== null
    ? `${gown.currency} ${gown.priceMinor / 100}`
    : "Price on request";

function recipients(): string[] {
  const values = env.STUDIO_ENQUIRY_EMAIL.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const parsed = z.array(z.string().email()).safeParse(values);
  if (!parsed.success || parsed.data.length === 0)
    throw new Error("Invalid studio mail recipients");
  return parsed.data;
}

function lines(data: EnquiryEmailData, studio: boolean): string {
  const gowns =
    data.gowns.length === 0
      ? "No gown selected."
      : data.gowns.map((gown) => `- ${text(gown.name)} — ${text(displayPrice(gown))}`).join("\n");
  return [
    `Reference: ${text(data.reference)}`,
    `Name: ${text(`${data.firstName} ${data.lastName}`)}`,
    `Contact number: ${text(data.contactNumber)}`,
    `Email: ${text(data.email)}`,
    `Wedding date: ${text(data.weddingDate)}`,
    `Lead-time band: ${text(data.leadTimeBand)}`,
    data.notice ? `Notice shown: ${text(data.notice)}` : "",
    "Selected gowns:",
    gowns,
    data.message ? `Message:\n${text(data.message)}` : "Message: None",
    studio
      ? `Short link: ${text(data.shortLinkUrl)}`
      : `Your short link: ${text(data.shortLinkUrl)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function rows(data: EnquiryEmailData, studio: boolean): string {
  const gownRows =
    data.gowns.length === 0
      ? "<li>No gown selected.</li>"
      : data.gowns
          .map((gown) => `<li>${html(gown.name)} — ${html(displayPrice(gown))}</li>`)
          .join("");
  return [
    `<p><strong>Reference:</strong> ${html(data.reference)}</p>`,
    `<p><strong>Name:</strong> ${html(`${data.firstName} ${data.lastName}`)}</p>`,
    `<p><strong>Contact number:</strong> ${html(data.contactNumber)}<br><strong>Email:</strong> ${html(data.email)}<br><strong>Wedding date:</strong> ${html(data.weddingDate)}</p>`,
    `<p><strong>Lead-time band:</strong> ${html(data.leadTimeBand)}${data.notice ? `<br><strong>Notice shown:</strong> ${html(data.notice)}` : ""}</p>`,
    `<p><strong>Selected gowns:</strong></p><ul>${gownRows}</ul>`,
    `<p><strong>Message:</strong><br>${data.message ? html(data.message).replaceAll("\n", "<br>") : "None"}</p>`,
    `<p><strong>${studio ? "Short link" : "Your short link"}:</strong> <a href="${html(data.shortLinkUrl)}">${html(data.shortLinkUrl)}</a></p>`,
  ].join("");
}

export function studioEnquiryEmail(data: EnquiryEmailData): MailMessage {
  return {
    to: recipients(),
    subject: `New enquiry ${data.reference}`,
    html: `<h1>New bridal enquiry</h1>${rows(data, true)}`,
    text: `New bridal enquiry\n\n${lines(data, true)}`,
    replyTo: data.email,
  };
}

export function brideEnquiryEmail(data: EnquiryEmailData): MailMessage {
  return {
    to: [data.email],
    subject: `Your Klei Bridal Studio enquiry ${data.reference}`,
    html: `<h1>Your enquiry is received</h1><p>Keep this reference for your records.</p>${rows(data, false)}`,
    text: `Your enquiry is received. Keep this reference for your records.\n\n${lines(data, false)}`,
  };
}

export function resendTransport(fetchImpl: typeof fetch = fetch): MailTransport {
  return {
    async send(message) {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.MAIL_PROVIDER_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: `${env.MAIL_FROM_NAME.replace(/[\r\n]/g, "")} <${env.MAIL_FROM_ADDRESS}>`,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
      });
      let requestId: string | undefined;
      if (!response.ok) {
        try {
          const body: unknown = await response.json();
          if (
            typeof body === "object" &&
            body !== null &&
            "id" in body &&
            typeof body.id === "string"
          ) {
            requestId = body.id;
          }
        } catch {
          // A provider error without JSON still remains retryable.
        }
        throw new MailProviderError("mail provider rejected request", requestId);
      }
      try {
        const body: unknown = await response.json();
        if (
          typeof body === "object" &&
          body !== null &&
          "id" in body &&
          typeof body.id === "string"
        ) {
          requestId = body.id;
        }
      } catch {
        // A successful provider response without JSON still counts as sent.
      }
      return { requestId };
    },
  };
}

async function mark(
  db: Database | undefined,
  enquiryId: string,
  field: "studioEmailStatus" | "brideEmailStatus",
  status: "sent" | "failed",
) {
  if (db)
    await db
      .update(enquiries)
      .set({ [field]: status })
      .where(eq(enquiries.id, enquiryId));
}

async function deliver(
  kind: "studio" | "bride",
  data: EnquiryEmailData,
  message: MailMessage,
  deps: EnquiryMailDeps,
) {
  const transport = deps.transport ?? resendTransport();
  const db = deps.db;
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const field = kind === "studio" ? "studioEmailStatus" : "brideEmailStatus";

  if (env.MAIL_DRY_RUN) {
    await mark(db, data.enquiryId, field, "sent");
    return;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await transport.send(message);
      await mark(db, data.enquiryId, field, "sent");
      return result;
    } catch (error: unknown) {
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]!);
      if (attempt === MAX_ATTEMPTS - 1) {
        await mark(db, data.enquiryId, field, "failed");
        deps.log?.(`enquiry ${kind} email failed after ${MAX_ATTEMPTS} attempts`, {
          enquiryId: data.enquiryId,
          ...(error instanceof MailProviderError && error.requestId
            ? { requestId: error.requestId }
            : {}),
        });
      }
    }
  }
}

/** Best-effort only. Call after the transaction has committed. */
export async function dispatchEnquiryEmails(data: EnquiryEmailData, deps: EnquiryMailDeps = {}) {
  const logger = deps.log ?? ((message, details) => console.error(`[mail] ${message}`, details));
  const deliveryDeps = { ...deps, log: logger };
  await Promise.all([
    deliver("studio", data, studioEnquiryEmail(data), deliveryDeps),
    deliver("bride", data, brideEnquiryEmail(data), deliveryDeps),
  ]);
}
