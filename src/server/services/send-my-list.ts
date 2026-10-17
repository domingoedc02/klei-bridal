import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { env } from "@/config/env";
import { db as defaultDb, type Database } from "@/server/db/client";
import { gowns } from "@/server/db/schema";
import { PipelineError } from "@/server/pipeline/errors";
import { enqueueMail } from "@/server/mail/mail-outbox";

export const sendMyListBodySchema = z.object({
  email: z.string().trim().max(254).email(),
  gown_ids: z.array(z.string().uuid()).max(50).transform((ids) => [...new Set(ids)]),
  studio_copy: z.boolean().optional().default(false),
});
export type SendMyListInput = z.infer<typeof sendMyListBodySchema>;

type Gown = {
  id: string;
  slug: string;
  name: string;
  priceMinor: number | null;
  currency: string;
  priceStatus: string;
};

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const price = (g: Gown) =>
  g.priceStatus === "priced" && g.priceMinor !== null
    ? `${g.currency} ${(g.priceMinor / 100).toFixed(2)}`
    : "Price on request";

export function sendMyListEmail(email: string, gownRows: Gown[]) {
  const lines = gownRows
    .map((g) => `- ${g.name} — ${price(g)}\n${env.SITE_URL}/gowns/${g.slug}`)
    .join("\n");
  const items = gownRows
    .map(
      (g) =>
        `<li><a href="${escape(env.SITE_URL)}/gowns/${escape(g.slug)}">${escape(g.name)}</a> — ${escape(price(g))}</li>`,
    )
    .join("");
  return {
    subject: "Your Klei Bridal Studio gown list",
    text: `Your saved gown list\n\n${lines}`,
    html: `<h1>Your saved gown list</h1><p>Here are the gowns you selected.</p><ul>${items}</ul>`,
  };
}

export async function sendMyList(input: SendMyListInput, db: Database = defaultDb) {
  const result = await db.transaction(async (tx) => {
    const rows =
      input.gown_ids.length === 0
        ? []
        : await tx
            .select({
              id: gowns.id,
              slug: gowns.slug,
              name: gowns.name,
              priceMinor: gowns.priceMinor,
              currency: gowns.currency,
              priceStatus: gowns.priceStatus,
            })
            .from(gowns)
            .where(and(inArray(gowns.id, input.gown_ids), eq(gowns.status, "published")));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const valid = input.gown_ids
      .map((id) => byId.get(id))
      .filter((row): row is Gown => !!row);
    if (valid.length === 0) {
      throw new PipelineError(422, "VALIDATION_ERROR", "Select at least one available gown.");
    }

    const message = sendMyListEmail(input.email, valid);
    const recipients = [input.email];
    if (input.studio_copy) {
      recipients.push(
        ...env.STUDIO_ENQUIRY_EMAIL.split(",").map((value) => value.trim()).filter(Boolean),
      );
    }
    for (const [index, to] of recipients.entries()) {
      await enqueueMail(tx, {
        idempotencyKey: `send-my-list:${randomUUID()}:${index}`,
        email: { to, ...message },
      });
    }
    return { sent: true as const };
  });
  return result;
}
