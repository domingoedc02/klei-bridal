import { NextRequest } from "next/server";

/** `duplex` is required by undici for a stream body but missing from the DOM/Next typings. */
type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;
import { PipelineError } from "./errors";

/** JSON bodies: 64KB (spec/architecture step 4). */
export const MAX_JSON_BYTES = 64 * 1024;
/** Multipart: 25MB per file, 10 files per request (spec/api image upload). */
export const MAX_MULTIPART_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MULTIPART_FILES = 10;

export interface BodyLimits {
  json: number;
  multipartFileBytes: number;
  multipartFiles: number;
}

export const defaultBodyLimits: BodyLimits = {
  json: MAX_JSON_BYTES,
  multipartFileBytes: MAX_MULTIPART_FILE_BYTES,
  multipartFiles: MAX_MULTIPART_FILES,
};

function tooLarge(detail: string): PipelineError {
  return new PipelineError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.", { detail });
}

function isMultipart(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").toLowerCase().includes("multipart/form-data");
}

/**
 * Caps the request body on the ACTUAL byte stream, not only on
 * `Content-Length` — a chunked upload carries no `Content-Length` at all, and
 * a declared one is a client claim. `Content-Length` is still checked first,
 * because rejecting before a 25MB upload is read is cheaper for both sides.
 *
 * Returns a request whose body errors with a 413 PipelineError once the cap is
 * passed, so the limit holds wherever the handler reads the body (`.json()`,
 * `.text()`, `.formData()`), not at a checkpoint it can skip.
 */
export function enforceBodyLimit(
  request: NextRequest,
  limits: BodyLimits = defaultBodyLimits,
): NextRequest {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return request;

  // Multipart: the whole-request backstop is files × per-file cap, plus the
  // JSON cap again as slack for MIME framing and text fields; the per-file
  // and per-count bounds are checked once parsed (readMultipart).
  const max = isMultipart(request)
    ? limits.multipartFileBytes * limits.multipartFiles + limits.json
    : limits.json;
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    throw tooLarge(`content-length ${declared} > ${max}`);
  }

  let seen = 0;
  const capped = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(tooLarge(`stream exceeded ${max} bytes`));
        else controller.enqueue(chunk);
      },
    }),
  );

  return new NextRequest(request, { body: capped, duplex: "half" } as NextRequestInit);
}

/**
 * The one way a handler reads JSON: a wrong content-type or an unparseable
 * body is a 400 (spec/api → Errors), a body over the cap stays a 413.
 */
export async function readJson(request: Request): Promise<unknown> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new PipelineError(400, "BAD_REQUEST", "Expected an application/json body.");
  }
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new PipelineError(400, "BAD_REQUEST", "Request body is not valid JSON.", {
      cause: error,
    });
  }
}

/**
 * Parses a multipart body and enforces the per-file and per-request file
 * counts. ponytail: `formData()` buffers the whole (≤250MB) body in memory;
 * stream parts to disk (busboy) if uploads ever outgrow the container's RAM.
 */
export async function readMultipart(
  request: Request,
  limits: BodyLimits = defaultBodyLimits,
): Promise<FormData> {
  if (!isMultipart(request)) {
    throw new PipelineError(400, "BAD_REQUEST", "Expected a multipart/form-data body.");
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new PipelineError(400, "BAD_REQUEST", "Request body is not valid multipart.", {
      cause: error,
    });
  }

  const files = [...form.values()].filter((value): value is File => value instanceof File);
  if (files.length > limits.multipartFiles) {
    throw tooLarge(`${files.length} files > ${limits.multipartFiles}`);
  }
  if (files.some((file) => file.size > limits.multipartFileBytes)) {
    throw tooLarge(`a file exceeded ${limits.multipartFileBytes} bytes`);
  }
  return form;
}
