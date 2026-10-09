import type { NextRequest } from "next/server";
import { z } from "zod";

import { budgets } from "@/server/ratelimit/budgets";
import { clientIp } from "@/server/ratelimit/client-ip";
import { PipelineError, requestIdOf, type Principal } from "@/server/pipeline";
import {
  createCategory,
  deleteCategory,
  listCategories,
  mergeCategory,
  updateCategory,
  type CategoryType,
} from "@/server/services/admin-categories";

/**
 * KBS-22-1/-2: the handlers behind /api/admin/{silhouettes,materials,collections},
 * their [id] and [id]/merge routes. Each route.ts still writes its own
 * `export const X = withPipeline(...)` (routeUsage.test.ts) and passes its
 * own literal type, so no path segment ever picks a table.
 */
const Name = z.string().trim().min(1).max(120);

export const CreateBody = z.object({
  name: Name,
  description: z.string().max(2000).nullable().optional(),
  confirm_near_duplicate: z.boolean().optional(),
});

export const PatchBody = z.object({
  name: Name.optional(),
  description: z.string().max(2000).nullable().optional(),
  sort_order: z.number().int().min(0).max(10_000).optional(),
  is_active: z.boolean().optional(),
});

export const Params = z.object({ id: z.string().uuid() });

export const MergeBody = z.object({ target_id: z.string().uuid() });

type IdContext = { params: Promise<{ id: string }>; principal: Principal };
// mergeOptions.body is set, so the pipeline always hands a validated body.
type MergeContext = IdContext & { body: z.infer<typeof MergeBody> };
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
        confirm: body.confirm_near_duplicate === true,
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

export function deleteHandler(type: CategoryType) {
  return async (request: NextRequest, context: IdContext) => {
    const { id } = await context.params;
    const result = await deleteCategory(type, id, context.principal, clientIp(request.headers));
    if ("deleted" in result) return new Response(null, { status: 204 });
    // Custom body like NEAR_DUPLICATE: spec/api wants gown_count and options.
    return Response.json(
      {
        error: {
          code: "IN_USE",
          message: `${result.inUse} gown(s) use this value. Merge it into another or deactivate it.`,
          request_id: requestIdOf(request.headers),
        },
        gown_count: result.inUse,
        options: ["merge", "deactivate"],
      },
      { status: 409 },
    );
  };
}

export function mergeHandler(type: CategoryType) {
  return async (request: NextRequest, context: MergeContext) => {
    const { id } = await context.params;
    return Response.json(
      await mergeCategory(
        type,
        id,
        context.body.target_id,
        context.principal,
        clientIp(request.headers),
      ),
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
export const deleteOptions = {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
} as const;
export const mergeOptions = {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
  body: MergeBody,
} as const;
