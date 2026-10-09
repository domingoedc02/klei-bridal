import { withPipeline } from "@/server/pipeline";
import { mergeHandler, mergeOptions } from "../../../_categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withPipeline(mergeHandler("materials"), mergeOptions);
