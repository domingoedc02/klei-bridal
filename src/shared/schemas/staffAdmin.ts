import { z } from "zod";

/** POST /api/admin/staff. Password is set through a single-use invite link. */
const staffCreateShape = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(120, "Use at most 120 characters."),
  email: z.string().trim().email("Enter a valid email.").max(320),
});
// Each extra key (password included) is named in `fields`, not lumped under `body`.
export const staffCreateSchema = staffCreateShape.catchall(
  z.unknown().refine(() => false, "not accepted"),
);

const password = z.string().min(1).max(1024);
export type StaffCreate = z.infer<typeof staffCreateShape>;

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
