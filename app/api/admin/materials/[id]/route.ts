import { withPipeline } from "@/server/pipeline";

import { deleteHandler, deleteOptions, patchHandler, patchOptions } from "../../_categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = withPipeline(patchHandler("materials"), patchOptions);
export const DELETE = withPipeline(deleteHandler("materials"), deleteOptions);
