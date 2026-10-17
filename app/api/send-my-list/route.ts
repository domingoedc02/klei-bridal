import type { NextRequest } from "next/server";

import { budgets } from "@/server/ratelimit/budgets";
import { withPipeline } from "@/server/pipeline";
import { sendMyList, sendMyListBodySchema, type SendMyListInput } from "@/server/services/send-my-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function handler(_request: NextRequest, context: { body?: SendMyListInput }) {
  if (!context.body) throw new Error("request body missing");
  return Response.json(await sendMyList(context.body), { status: 202, headers: { "cache-control": "no-store" } });
}

export const POST = withPipeline(handler, { auth: "public", rateLimit: budgets.sendMyList, body: sendMyListBodySchema });
