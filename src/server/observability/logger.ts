import pino from "pino";
import { scrubString, scrubValue } from "./scrub";

/**
 * The one structured logger: JSON to stdout, read in Dokploy's log viewer
 * (spec/operations → Logs). No transport, no pretty-printer in production.
 *
 * Redaction runs twice, deliberately: pino's `redact` drops known paths
 * cheaply, and the `log` formatter runs every field through the same
 * `scrubValue` Sentry's `beforeSend` uses — so a log line can never carry
 * what an error report may not (cookies, session/CSRF/short-link/reset
 * tokens, mail keys, bride email/phone/name/message).
 */
/** `destination` is a test seam; production writes stdout. */
export function createLogger(destination?: pino.DestinationStream, level?: string) {
  return pino(
    {
      // NODE_ENV only (a build-time constant Next inlines), so the logger imports
      // without the full env schema and stays usable from tests and scripts.
      level: level ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
      base: { service: "kbs-web" },
      messageKey: "msg",
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          'res.headers["set-cookie"]',
          "*.cookie",
          "*.authorization",
          "*.password",
        ],
        censor: "[redacted]",
      },
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => scrubValue(object) as Record<string, unknown>,
      },
      hooks: {
        // The message string is not covered by `formatters.log`.
        logMethod(args, method) {
          const scrubbed = args.map((arg) => (typeof arg === "string" ? scrubString(arg) : arg));
          return method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
    },
    destination ?? pino.destination(1),
  );
}

export const logger = createLogger();
