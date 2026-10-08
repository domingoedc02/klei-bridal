import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import type { Budget } from "../ratelimit/budgets";
import type { RateLimitStore } from "../ratelimit/store";
import { SESSION_COOKIE, SESSION_TOKEN_PATTERN, validateSession } from "../auth/session";
import { clientIp } from "../ratelimit/client-ip";
import { defaultBodyLimits, enforceBodyLimit, type BodyLimits } from "./body-limit";
import { consoleReporter, mapError, type Reporter } from "./error-mapper";
import { applySecurityHeaders } from "./headers";
import { requestIdOf } from "./request-id";
import { enforceRateLimit } from "./rate-limit";
import {
  csrfCookieValue,
  csrfSetCookie,
  isChannelBeacon,
  isStateChanging,
  mintCsrfToken,
  requireCsrf,
  requireSameOrigin,
} from "./csrf";
import { requireStaff, type Principal } from "./authorization";
import { db } from "../db/client";

export { PipelineError, SilentlyDropped } from "./errors";
export { CSRF_COOKIE, csrfSetCookie, mintCsrfToken } from "./csrf";
export type { Principal } from "./authorization";
export { readJson, readMultipart } from "./body-limit";
export { enforceRateLimit } from "./rate-limit";
export { requestIdOf } from "./request-id";

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
  /** Test seam; production uses the DB-backed validator. */
  sessionValidator?: (token: string | undefined) => Promise<Principal | null>;
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
  // A session budget falls back to the IP when there is no well-formed
  // session cookie: a cookieless or random-cookie caller must not get a
  // fresh (or shared, empty) bucket per request.
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (budget.dimension === "session" && token && SESSION_TOKEN_PATTERN.test(token)) {
    return sha256(token);
  }
  return clientIp(request.headers);
}

function finalize(response: Response, requestId: string, request: NextRequest): Response {
  let out = response;
  try {
    out.headers.set("x-request-id", requestId);
  } catch {
    // Response.redirect() and fetch() responses have immutable headers.
    out = new Response(response.body, response);
    out.headers.set("x-request-id", requestId);
  }
  if (response.status < 400 && !csrfCookieValue(request)) {
    out.headers.append("set-cookie", csrfSetCookie(mintCsrfToken()));
  }
  const nonce = request.headers.get("x-nonce") ?? undefined;
  applySecurityHeaders(out.headers, request.nextUrl.pathname, { keepExisting: true, nonce });
  return out;
}

/**
 * The request chain every route handler runs through (spec/architecture
 * steps 4-11): body limit → rate limit → [session → CSRF → authorization:
 * KBS-11-2] → [validation: KBS-11-3] → handler → error mapper. Security
 * headers and the request id land on EVERY response, error responses included.
 */
export function withPipeline<C>(
  handler: Handler<C>,
  options: PipelineOptions,
): (request: NextRequest, context?: C) => Promise<Response> {
  const report = options.report ?? consoleReporter;

  return async (request, context) => {
    const requestId = requestIdOf(request.headers);
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

      const principal = options.sessionValidator
        ? await options.sessionValidator(request.cookies.get(SESSION_COOKIE)?.value)
        : await validateSession(db, request.cookies.get(SESSION_COOKIE)?.value);
      if (options.auth === "staff") requireStaff(principal);
      if (isStateChanging(request)) {
        if (isChannelBeacon(request)) requireSameOrigin(request, true);
        else requireCsrf(request);
      }

      response = await handler(limited, {
        ...(context && typeof context === "object" ? context : {}),
        principal,
      } as unknown as C);
    } catch (error) {
      // redirect() / notFound() are control flow, not failures.
      unstable_rethrow(error);
      response = mapError(error, requestId, report);
    }
    return finalize(response, requestId, request);
  };
}
