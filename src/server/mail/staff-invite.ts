import { env } from "@/config/env";

export interface StaffInviteEmail {
  name: string;
  token: string;
  expiresAt: Date;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

export function staffInviteEmail(input: StaffInviteEmail) {
  const url = `${env.SITE_URL}/admin/reset-password?token=${encodeURIComponent(input.token)}`;
  const name = input.name.trim() || "there";
  return {
    subject: "Set your Klei Bridal Studio staff password",
    text: `Hello ${name},\n\nSet your staff password here: ${url}\n\nThis single-use link expires in 24 hours. If you did not expect this invitation, contact the studio administrator.`,
    html: `<p>Hello ${escapeHtml(name)},</p><p><a href="${escapeHtml(url)}">Set your staff password</a></p><p>This single-use link expires in 24 hours. If you did not expect this invitation, contact the studio administrator.</p>`,
  };
}
