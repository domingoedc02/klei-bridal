import { z } from "zod";

const password = z.string().min(1).max(1024);

/** POST /api/admin/staff. Password is temporary and never returned. */
export const staffCreateSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(120, "Use at most 120 characters."),
    email: z.string().trim().email("Enter a valid email.").max(320),
    password,
  })
  .strict();
export type StaffCreate = z.infer<typeof staffCreateSchema>;

/** PATCH /admin/staff/:id. Disable only; password resets force a new temporary password. */
export const staffPatchSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(120, "Use at most 120 characters."),
    is_active: z.boolean(),
    password,
  })
  .partial()
  .strict()
  .refine((b) => b.name !== undefined || b.is_active !== undefined || b.password !== undefined, {
    message: "Send name, is_active or password.",
  });
export type StaffPatch = z.infer<typeof staffPatchSchema>;
