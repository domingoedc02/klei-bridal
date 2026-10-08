/**
 * The one error type the pipeline throws and the error mapper understands.
 * `detail` never reaches the client — it goes to the reporter (Sentry) only
 * (spec/api → Errors: "never internal detail to the client").
 */
export class PipelineError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly retryAfterSec?: number;
  readonly detail?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: {
      fields?: Record<string, string>;
      retryAfterSec?: number;
      detail?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: extra.cause });
    this.name = "PipelineError";
    this.status = status;
    this.code = code;
    if (extra.fields) this.fields = extra.fields;
    if (extra.retryAfterSec !== undefined) this.retryAfterSec = extra.retryAfterSec;
    if (extra.detail) this.detail = extra.detail;
  }
}

/**
 * A rate-limited response the bride must never see as an error: the channel
 * beacon's neutral 204 (spec/api). Carries no body and no `Retry-After`.
 */
export class SilentlyDropped extends Error {
  constructor() {
    super("silently dropped");
    this.name = "SilentlyDropped";
  }
}
