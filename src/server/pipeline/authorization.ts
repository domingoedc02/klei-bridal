import { PipelineError } from "./errors";

export type Principal = {
  sessionId: string;
  expiresAt: Date;
  staff: { id: string; name: string; email: string };
  passwordChangeRequired?: boolean;
};

/** One permission level in release 1: every active staff member is allowed. */
export function requireStaff(
  principal: Principal | null,
  options: { passwordChangeExempt?: boolean } = {},
): Principal {
  if (!principal) {
    throw new PipelineError(401, "UNAUTHENTICATED", "Please sign in.");
  }
  if (principal.passwordChangeRequired && !options.passwordChangeExempt) {
    throw new PipelineError(403, "PASSWORD_CHANGE_REQUIRED", "Change your password to continue.");
  }
  return principal;
}
