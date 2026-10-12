import { z } from "zod";

/** PATCH /admin/staff/:id (KBS-24-1). No delete exists anywhere: a leaver is disabled. */
export const staffPatchSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(120, "Use at most 120 characters."),
    is_active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((b) => b.name !== undefined || b.is_active !== undefined, {
    message: "Send name or is_active.",
  });
export type StaffPatch = z.infer<typeof staffPatchSchema>;
