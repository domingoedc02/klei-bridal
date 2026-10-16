import type { NextRequest } from "next/server";

import { withPipeline } from "@/server/pipeline";
import { budgets } from "@/server/ratelimit/budgets";
import { recordChatChannel } from "@/server/services/short-link";
import { chatChannelSchema, type ChatChannel } from "@/shared/schemas/chatChannel";

// POST /e/:token/channel (KBS-29-4). Sent by sendBeacon, which cannot carry
// the CSRF header, so the pipeline runs requireChannelOrigin (Origin AND
// Sec-Fetch-Site must be same-origin) before anything else for this path.
// Always 204 for a valid, archived, erased or unknown token.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }>; body: { channel: ChatChannel } };

async function handler(_request: NextRequest, context: Context) {
  const { token } = await context.params;
  await recordChatChannel(token, context.body.channel);
  return new Response(null, { status: 204 });
}

export const POST = withPipeline(handler, {
  auth: "public",
  rateLimit: budgets.enquiryChannel,
  body: chatChannelSchema,
});
