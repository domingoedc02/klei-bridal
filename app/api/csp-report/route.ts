import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { logger } from "@/server/observability/logger";
import { withPipeline } from "@/server/pipeline";
import { requestIdOf } from "@/server/pipeline/request-id";
import { budgets } from "@/server/ratelimit/budgets";

const MAX_REPORT_BYTES = 16 * 1024;
const MAX_STRING = 512;
const MAX_REPORTS = 20;

export const cspReportBodyLimits = {
  json: MAX_REPORT_BYTES,
  multipartFileBytes: MAX_REPORT_BYTES,
  multipartFiles: 1,
};
const acceptedTypes = new Set(["application/csp-report", "application/reports+json"]);
const stringFields = new Set([
  "document-uri",
  "blocked-uri",
  "violated-directive",
  "effective-directive",
  "original-policy",
  "source-file",
]);
const numberFields = new Set(["line-number", "column-number"]);

type SanitizedReport = {
  stringFields: number;
  numericFields: number;
  reports: number;
};

export function mediaType(request: Request): string {
  return request.headers.get("content-type")?.trim().toLowerCase() ?? "";
}

function sanitizeOne(value: unknown): { stringFields: number; numericFields: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let stringCount = 0;
  let numericCount = 0;
  for (const [key, field] of Object.entries(value)) {
    if (stringFields.has(key)) {
      if (typeof field !== "string" || field.length > MAX_STRING) return null;
      stringCount += 1;
    } else if (numberFields.has(key)) {
      if (
        typeof field !== "number" ||
        !Number.isInteger(field) ||
        field < 0 ||
        field > 2 ** 31 - 1
      ) {
        return null;
      }
      numericCount += 1;
    }
  }
  return { stringFields: stringCount, numericFields: numericCount };
}

export function sanitizeReport(payload: unknown): SanitizedReport | null {
  const values = Array.isArray(payload) ? payload : [payload];
  if (values.length === 0 || values.length > MAX_REPORTS) return null;
  let stringFieldsCount = 0;
  let numericFieldsCount = 0;
  for (const value of values) {
    const result = sanitizeOne(value);
    if (!result) return null;
    stringFieldsCount += result.stringFields;
    numericFieldsCount += result.numericFields;
  }
  return {
    stringFields: stringFieldsCount,
    numericFields: numericFieldsCount,
    reports: values.length,
  };
}

/** Bounded, sanitized report sink; lands in the structured log (KBS-33-1) for review in Dokploy. */
export async function cspReportHandler(request: NextRequest): Promise<Response> {
  if (!acceptedTypes.has(mediaType(request))) return new Response(null, { status: 415 });
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) {
    return new Response(null, { status: 413 });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REPORT_BYTES) {
    return new Response(null, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  const report = sanitizeReport(payload);
  if (!report) return new Response(null, { status: 400 });
  logger.info(
    {
      event: "csp_violation",
      // Same validation as the pipeline: a raw header could inject markup or a huge value into logs.
      request_id: requestIdOf(request.headers),
      reports: report.reports,
      string_fields: report.stringFields,
      numeric_fields: report.numericFields,
    },
    "csp_violation",
  );
  return NextResponse.json({ ok: true });
}

export const POST = withPipeline(cspReportHandler, {
  auth: "public",
  // Browsers send reports with no page JS, so no x-csrf-token; stateless sink.
  csrf: false,
  rateLimit: budgets.cspReport,
  bodyLimits: cspReportBodyLimits,
});
