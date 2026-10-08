import type { ZodErrorMap, ZodTypeAny, z } from "zod";

import { PipelineError } from "./errors";

/** Bounds on the 422 `fields` map: a hostile payload cannot grow the response. */
export const MAX_FIELDS = 20;
const MAX_KEY = 64;

// Zod's default enum message quotes the received value back
// ("…received 'x'"); every other default names only types and limits.
const noEcho: ZodErrorMap = (issue, ctx) => ({
  message: issue.code === "invalid_enum_value" ? "Invalid value." : ctx.defaultError,
});

/**
 * Parses untrusted input with a route's schema (spec/api → Errors): 422
 * VALIDATION_ERROR naming each offending field, never echoing its value.
 * Unknown keys are stripped — z.object's default; never `.passthrough()`.
 */
export function validate<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input, { errorMap: noEcho });
  if (parsed.success) return parsed.data;
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    const key = (issue.path.join(".") || "body").slice(0, MAX_KEY);
    fields[key] ??= issue.message;
  }
  throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", { fields });
}
