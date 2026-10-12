import { z } from "zod";

/** Staff inbox writes (KBS-23-2, spec/api/admin-enquiries). Shared so the UI's select uses the same values. */
export const ENQUIRY_STATUSES = ["new", "read", "archived"] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

/** Never free text: `reason` lands in the append-only audit log forever (security-eng condition A). */
export const ENQUIRY_ERASE_REASONS = [
  "data_subject_request",
  "retention_policy",
  "duplicate_or_test",
] as const;
export type EnquiryEraseReason = (typeof ENQUIRY_ERASE_REASONS)[number];

export const enquiryStatusPatchSchema = z.object({ status: z.enum(ENQUIRY_STATUSES) }).strict();

export const enquiryErasePatchSchema = z
  .object({ confirm: z.literal(true), reason: z.enum(ENQUIRY_ERASE_REASONS) })
  .strict();
