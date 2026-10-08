import { PipelineError } from "./errors";

export type Principal = {
  sessionId: string;
  expiresAt: Date;
  staff: { id: string; name: string; email: string };
};

/** One permission level in release 1: every active staff member is allowed. */
export function requireStaff(principal: Principal | null): Principal {
  if (!principal) {
    throw new PipelineError(401, "UNAUTHENTICATED", "Please sign in.");
  }
  return principal;
}
