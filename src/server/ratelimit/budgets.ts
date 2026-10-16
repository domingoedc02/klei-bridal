/**
 * One named budget per route (spec/security → Rate limiting, spec/api →
 * Idempotency & rate limits). Counter keys are
 * `rl:<route-name>:<dimension>:<id>` (spec/file-structure → Naming).
 *
 * Sign-in is NOT here: its limits count failures only, in
 * src/server/ratelimit/login.ts (one source of truth), so the login route
 * passes `rateLimit: null`.
 *
 * `failMode` is what happens when Valkey is unreachable: public writes fail
 * CLOSED (an outage must never hand an attacker unlimited attempts); the
 * enquiry link, the analytics-only channel beacon and admin writes fail
 * OPEN (a limiter outage must not 503 a bride's own link).
 * Other public reads carry no budget at all (spec/security), so they pass
 * `rateLimit: null` to withPipeline and an outage cannot touch them.
 *
 * `onExceeded` is "silent-204" only for the channel beacon, which never
 * surfaces a 429 or a `Retry-After` to the bride (spec/api).
 */
export interface Budget {
  name: string;
  dimension: "ip" | "session" | "target" | "actor";
  limit: number;
  windowSec: number;
  failMode: "open" | "closed";
  onExceeded: "429" | "silent-204";
}

export const budgets = {
  enquirySubmit: {
    name: "enquiry-submit",
    dimension: "ip",
    limit: 5,
    windowSec: 600,
    failMode: "closed",
    onExceeded: "429",
  },
  sendMyList: {
    name: "send-my-list",
    dimension: "ip",
    limit: 5,
    windowSec: 3600,
    failMode: "closed",
    onExceeded: "429",
  },
  passwordResetRequest: {
    name: "password-reset-request",
    dimension: "ip",
    limit: 5,
    windowSec: 900,
    failMode: "closed",
    onExceeded: "429",
  },
  passwordResetEmail: {
    name: "password-reset-email",
    dimension: "ip",
    limit: 3,
    windowSec: 900,
    failMode: "closed",
    onExceeded: "429",
  },
  staffInviteRedemption: {
    name: "staff-invite-redemption",
    dimension: "ip",
    limit: 3,
    windowSec: 900,
    failMode: "closed",
    onExceeded: "429",
  },
  enquiryLink: {
    name: "enquiry-link",
    dimension: "ip",
    limit: 30,
    windowSec: 60,
    failMode: "open",
    onExceeded: "429",
  },
  enquiryChannel: {
    name: "enquiry-channel",
    dimension: "ip",
    limit: 20,
    windowSec: 60,
    failMode: "open",
    onExceeded: "silent-204",
  },
  adminWrite: {
    name: "admin-write",
    dimension: "session",
    limit: 120,
    windowSec: 60,
    failMode: "open",
    onExceeded: "429",
  },
  cspReport: {
    name: "csp-report",
    dimension: "ip",
    limit: 30,
    windowSec: 60,
    failMode: "closed",
    onExceeded: "429",
  },
  // Resend's delivery events. Fails OPEN: a limiter outage must not drop a studio-bounce alert.
  mailWebhook: {
    name: "mail-webhook",
    dimension: "ip",
    limit: 120,
    windowSec: 60,
    failMode: "open",
    onExceeded: "429",
  },
} as const satisfies Record<string, Budget>;
