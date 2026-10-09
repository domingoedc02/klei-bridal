import type { NextRequest } from "next/server";
import { z } from "zod";

import { budgets } from "@/server/ratelimit/budgets";
import { clientIp } from "@/server/ratelimit/client-ip";
import { PipelineError, requestIdOf, type Principal } from "@/server/pipeline";
import {
  createCategory,
  listCategories,
  updateCategory,
  type CategoryType,
} from "@/server/services/admin-categories";

/**
 * KBS-22-1: the handlers behind /api/admin/{silhouettes,materials,collections}
 * and their [id] routes. Each route.ts still writes its own
 * `export const X = withPipeline(...)` (routeUsage.test.ts) and passes its
 * own literal type, so no path segment ever picks a table.
 */
const Name = z.string().trim().min(1).max(120);

export const CreateBody = z.object({
  name: Name,
  description: z.string().max(2000).nullable().optional(),
  // CategoryForm.tsx sends confirm_near_duplicate; spec/api names it confirm.
  confirm_near_duplicate: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

export const PatchBody = z.object({
  name: Name.optional(),
  description: z.string().max(2000).nullable().optional(),
  sort_order: z.number().int().min(0).max(10_000).optional(),
  is_active: z.boolean().optional(),
});

export const Params = z.object({ id: z.string().uuid() });

type CreateContext = { principal: Principal; body?: z.infer<typeof CreateBody> };
type PatchContext = {
  params: Promise<{ id: string }>;
  principal: Principal;
  body?: z.infer<typeof PatchBody>;
};

export function listHandler(type: CategoryType) {
  return async () => Response.json(await listCategories(type));
}

export function createHandler(type: CategoryType) {
  return async (request: NextRequest, context: CreateContext) => {
    const body = context.body;
    if (!body) throw new PipelineError(400, "BAD_REQUEST", "Request body is required.");
    const result = await createCategory(
      type,
      {
        name: body.name,
        description: body.description,
        confirm: body.confirm_near_duplicate === true || body.confirm === true,
      },
      context.principal,
      clientIp(request.headers),
    );
    if (result.created) return Response.json(result.item, { status: 201 });
    // Not an error the pipeline maps: the strict envelope would drop
    // `suggestion`, which CategoryForm needs for its "Create anyway" button.
    return Response.json(
      {
        error: {
          code: "NEAR_DUPLICATE",
          message: `A similar value, "${result.suggestion.name}", already exists.`,
          // middleware.ts has already fixed x-request-id on the request.
          request_id: requestIdOf(request.headers),
        },
        suggestion: result.suggestion,
      },
      { status: 409 },
    );
  };
}

export function patchHandler(type: CategoryType) {
  return async (request: NextRequest, context: PatchContext) => {
    const { id } = await context.params;
    if (!context.body) throw new PipelineError(400, "BAD_REQUEST", "Request body is required.");
    return Response.json(
      await updateCategory(type, id, context.body, context.principal, clientIp(request.headers)),
    );
  };
}

export const listOptions = { auth: "staff", rateLimit: null } as const;
export const createOptions = {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  body: CreateBody,
} as const;
export const patchOptions = {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
  body: PatchBody,
} as const;
