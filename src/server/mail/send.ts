import { env } from "@/config/env";

export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Send one transactional message through Resend. Dry-run keeps CI and local
 * development network-free while exercising callers and template generation.
 */
export async function sendTransactionalEmail(
  message: TransactionalEmail,
  options: { idempotencyKey?: string } = {},
): Promise<{ providerMessageId?: string }> {
  if (env.MAIL_DRY_RUN) return {};

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MAIL_PROVIDER_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: `${env.MAIL_FROM_NAME} <${env.MAIL_FROM_ADDRESS}>`,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });

  if (!response.ok) throw new Error("transactional email provider rejected message");
  const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
  return typeof body?.id === "string" ? { providerMessageId: body.id } : {};
}
