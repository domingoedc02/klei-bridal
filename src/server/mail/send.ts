import { env } from "@/config/env";

export interface TransactionalEmail {
  to: string | string[];
  subject: string;
  text: string;
  html: string;
}

/** Shared transactional mail boundary. Callers must not log bearer secrets. */
export async function sendTransactionalEmail(message: TransactionalEmail): Promise<void> {
  if (env.MAIL_DRY_RUN) return;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.MAIL_PROVIDER_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `${env.MAIL_FROM_NAME} <${env.MAIL_FROM_ADDRESS}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });

  if (!response.ok) throw new Error(`mail provider rejected request (${response.status})`);
}
