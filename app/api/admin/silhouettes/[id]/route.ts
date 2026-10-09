import { withPipeline } from "@/server/pipeline";

import { patchHandler, patchOptions } from "../../_categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = withPipeline(patchHandler("silhouettes"), patchOptions);
