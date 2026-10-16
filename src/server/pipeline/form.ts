import type { FormErrorCode } from "../../shared/enquiryForm";
import { PipelineError } from "./errors";
import type { Reporter } from "./error-mapper";

/**
 * Native `<form method=post>` support for ONE route (KBS-89,
 * decision/enquiry-nojs-csrf). Opt-in per route and allowlisted by
 * tests/unit/pipeline/routeUsage.test.ts, like `csrf: false`.
 */
export interface FormOptions {
  /** Fixed same-origin page that shows the error state. Never taken from input. */
  path: string;
  /** Form fields read into the body, and the only names echoed in `?fields=`. */
  fields: readonly string[];
  /** Fields that may repeat (`getAll`), e.g. gown_ids. */
  repeatable?: readonly string[];
  /** Optional fields a browser submits as "" when left blank: dropped, like the JS path's `|| undefined`. */
  omitEmpty?: readonly string[];
}

export const FORM_CSRF_FIELD = "csrf_token";

export function isFormRequest(request: Request): boolean {
  return (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/x-www-form-urlencoded");
}

/** Reads an urlencoded body through the (already size-capped) request. */
export async function readForm(
  request: Request,
  form: FormOptions,
): Promise<{ csrf: string | null; body: Record<string, string | string[]> }> {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await request.text());
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new PipelineError(400, "BAD_REQUEST", "Request body is not a valid form.", {
      cause: error,
    });
  }
  const body: Record<string, string | string[]> = {};
  for (const name of form.fields) {
    if (form.repeatable?.includes(name)) body[name] = params.getAll(name);
    else {
      const value = params.get(name);
      if (value !== null && !(value === "" && form.omitEmpty?.includes(name))) body[name] = value;
    }
  }
  return { csrf: params.get(FORM_CSRF_FIELD), body };
}

/** 303 so the browser follows with GET; `location` is a fixed same-origin path. */
export function formRedirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}

function errorCode(error: unknown): FormErrorCode {
  if (!(error instanceof PipelineError)) return "unavailable";
  if (error.status === 403) return "csrf";
  if (error.status === 422) return "invalid";
  if (error.status === 429) return "rate_limited";
  if (error.status === 400 || error.status === 413) return "bad_request";
  return "unavailable";
}

/**
 * Any failure on the form path becomes a 303 to the fixed error state with an
 * allowlisted code and field names — no values, no PII, no tokens in the URL.
 * Unexpected failures are reported exactly as the JSON error mapper does.
 */
export function formErrorResponse(
  error: unknown,
  form: FormOptions,
  requestId: string,
  report: Reporter,
): Response {
  if (!(error instanceof PipelineError) || error.status >= 500) report(error, { requestId });
  const code = errorCode(error);
  const params = new URLSearchParams({ error: code });
  if (code === "invalid" && error instanceof PipelineError && error.fields) {
    const names = [
      ...new Set(Object.keys(error.fields).map((key) => key.split(".")[0] ?? "")),
    ].filter((name) => form.fields.includes(name));
    if (names.length) params.set("fields", names.join(","));
  }
  return formRedirect(`${form.path}?${params}`);
}
