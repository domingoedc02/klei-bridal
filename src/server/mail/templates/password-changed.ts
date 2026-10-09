import { isIP } from "node:net";

export interface PasswordChangedEmailInput {
  name: string;
  occurredAt: Date;
  ip: string | null;
  userAgent: string | null;
  timezone: string;
}

export interface PasswordChangedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function approximateIp(ip: string | null): string {
  if (!ip || isIP(ip) === 0) return "unknown";
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return `${parts.slice(0, 3).join(":")}::/48`;
  }
  const parts = ip.split(".");
  return `${parts.slice(0, 3).join(".")}.0/24`;
}

export function passwordChangedEmail(input: PasswordChangedEmailInput): PasswordChangedEmail {
  const name = input.name.trim() || "there";
  const time = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: input.timezone,
    timeZoneName: "short",
  }).format(input.occurredAt);
  const ip = approximateIp(input.ip);
  const userAgent = input.userAgent?.trim() || "unknown";
  const safeName = escapeHtml(name);
  const safeTime = escapeHtml(time);
  const safeIp = escapeHtml(ip);
  const safeUserAgent = escapeHtml(userAgent);
  return {
    subject: "Your Klei Bridal password was changed",
    text: [
      `Hello ${name},`,
      "",
      "Your Klei Bridal password was changed.",
      `Time: ${time}`,
      `Approximate location: ${ip}`,
      `Device: ${userAgent}`,
      "",
      "If this was not you, contact the studio administrator and reset your password.",
    ].join("\n"),
    html: [
      `<p>Hello ${safeName},</p>`,
      "<p>Your Klei Bridal password was changed.</p>",
      `<p>Time: ${safeTime}<br>Approximate location: ${safeIp}<br>Device: ${safeUserAgent}</p>`,
      "<p>If this was not you, contact the studio administrator and reset your password.</p>",
    ].join(""),
  };
}
