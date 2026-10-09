import { withPipeline } from "@/server/pipeline";

import { createHandler, createOptions, listHandler, listOptions } from "../_categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withPipeline(listHandler("collections"), listOptions);
export const POST = withPipeline(createHandler("collections"), createOptions);
