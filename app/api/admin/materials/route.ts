import { withPipeline } from "@/server/pipeline";

import { createHandler, createOptions, listHandler, listOptions } from "../_categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withPipeline(listHandler("materials"), listOptions);
export const POST = withPipeline(createHandler("materials"), createOptions);
