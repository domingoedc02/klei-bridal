import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import type { Budget } from "../ratelimit/budgets";
import type { RateLimitStore } from "../ratelimit/store";
import { defaultBodyLimits, enforceBodyLimit, type BodyLimits } from "./body-limit";
import { clientIp } from "./clientIp";
import { consoleReporter, mapError, type Reporter } from "./error-mapper";
import { PipelineError } from "./errors";
import { applySecurityHeaders } from "./headers";
import { enforceRateLimit } from "./rate-limit";

export { PipelineError, SilentlyDropped } from "./errors";
export { readJson, readMultipart } from "./body-limit";
export { enforceRateLimit } from "./rate-limit";

export interface PipelineOptions {
  /**
   * Explicit on every route — there is no default, so a staff route can never
   * be public by omission. Session lookup is KBS-11-2; until it lands every
   * "staff" route answers 401 (fails closed).
   */
  auth: "public" | "staff";
  /** A named budget, or `null` for a public read that carries none. Never implicit. */
  rateLimit: Budget | null;
  /** Test seams. Production uses the Valkey store and the server-log reporter. */
  rateLimitStore?: () => RateLimitStore;
  report?: Reporter;
  bodyLimits?: BodyLimits;
}

type Handler<C> = (request: NextRequest, context: C) => Promise<Response> | Response;

async function defaultStore(): Promise<RateLimitStore> {
  // Lazy: importing the Valkey client (and env) only when a budget is used
  // keeps `rateLimit: null` routes and unit tests free of the connection.
  const { getRateLimitStore } = await import("../ratelimit");
  return getRateLimitStore();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

/** The id a budget counts against. A session cookie is hashed: no token is ever a Valkey key. */
async function budgetId(budget: Budget, request: NextRequest): Promise<string> {
  if (budget.dimension === "ip") return clientIp(request);
  if (budget.dimension === "session") {
    return sha256(request.cookies.get("kbs_session")?.value ?? "");
  }
  throw new Error(`budget ${budget.name}/${budget.dimension} is applied by its handler`);
}

function finalize(response: Response, requestId: string): Response {
  let out = response;
  try {
    out.headers.set("x-request-id", requestId);
  } catch {
    // Response.redirect() and fetch() responses have immutable headers.
    out = new Response(response.body, response);
    out.headers.set("x-request-id", requestId);
  }
  applySecurityHeaders(out.headers);
  return out;
}

/**
 * The request chain every route handler runs through (spec/architecture
 * steps 4-11): body limit → rate limit → [session → CSRF → authorization:
 * KBS-11-2] → [validation: KBS-11-3] → handler → error mapper. Security
 * headers and the request id land on EVERY response, error responses included.
 */
export function withPipeline<C>(handler: Handler<C>, options: PipelineOptions): Handler<C> {
  if (options.rateLimit?.dimension === "account") {
    throw new Error("per-account budgets are applied by the handler via enforceRateLimit");
  }
  const report = options.report ?? consoleReporter;

  return async (request, context) => {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    let response: Response;
    try {
      const limited = enforceBodyLimit(request, options.bodyLimits ?? defaultBodyLimits);

      if (options.rateLimit) {
        const store = options.rateLimitStore ? options.rateLimitStore() : await defaultStore();
        await enforceRateLimit(
          options.rateLimit,
          await budgetId(options.rateLimit, request),
          store,
        );
      }

      if (options.auth === "staff") {
        throw new PipelineError(401, "UNAUTHENTICATED", "Please sign in.");
      }

      response = await handler(limited, context);
    } catch (error) {
      // redirect() / notFound() are control flow, not failures.
      unstable_rethrow(error);
      response = mapError(error, requestId, report);
    }
    return finalize(response, requestId);
  };
}
