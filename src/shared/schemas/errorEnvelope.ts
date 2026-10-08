import { z } from "zod";

/**
 * The one error envelope every pipeline failure returns (spec/api → Errors).
 * `fields` appears only on 422. Shared so a client-side error display can
 * parse it with the same definition the server emits.
 */
export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        request_id: z.string(),
        fields: z.record(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
