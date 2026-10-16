import "server-only";
import { and, asc, eq, inArray, not } from "drizzle-orm";

import { db as defaultDb, type Database } from "@/server/db/client";
import { validateSession, type ValidSession } from "@/server/auth/session";
import { auditLog, enquiries, enquiryGowns, gownImages } from "@/server/db/schema";
import type { Principal } from "@/server/pipeline";
import { inetOrNull } from "@/server/ratelimit/client-ip";
import { MEDIA_PREFIX, type DerivativeManifest } from "@/shared/images";
import type { ChatChannel } from "@/shared/schemas/chatChannel";

import { isErased } from "./enquiry-erasure";
import { hashLinkToken } from "./enquiries";
import type { ShortLinkView } from "../short-link/render";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PHOTO_WIDTH = 768;

/** Page adapter keeps app/** free of DB imports and session implementation details. */
export async function pagePrincipal(token: string | undefined): Promise<ValidSession | null> {
  return validateSession(defaultDb, token);
}

/** One derivative path near PHOTO_WIDTH (webp, else jpeg). Never `original_path`. */
export function photoUrl(derivatives: unknown): string | null {
  if (!derivatives || typeof derivatives !== "object") return null;
  const entries = Object.entries(derivatives as DerivativeManifest)
    .map(([width, formats]) => ({ width: Number(width), path: formats?.webp ?? formats?.jpeg }))
    .filter((e) => Number.isInteger(e.width) && e.width > 0 && typeof e.path === "string")
    .sort((a, b) => Math.abs(a.width - PHOTO_WIDTH) - Math.abs(b.width - PHOTO_WIDTH));
  return entries[0] ? `${MEDIA_PREFIX}${entries[0].path}` : null;
}

export type ShortLinkResult =
  | { kind: "closed" }
  | { kind: "open"; view: ShortLinkView }
  | { kind: "staff"; enquiryId: string };

/**
 * GET /e/:token (KBS-29). Looked up by sha256(token) only. Unknown, archived
 * and erased all come back `closed`, and every path runs the same two
 * queries (a miss uses a nil id for the gown query) so there is no
 * early-return timing oracle. A staff actor on a real enquiry gets the id
 * and an `enquiry.view` audit row written in the SAME transaction as the
 * read: no audit row, no redirect.
 */
export async function resolveShortLink(
  token: string,
  actor: Principal | null,
  ip: string | null,
  database: Database = defaultDb,
): Promise<ShortLinkResult> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: enquiries.id,
        reference: enquiries.reference,
        status: enquiries.status,
        erased: isErased,
      })
      .from(enquiries)
      .where(eq(enquiries.tokenHash, hashLinkToken(token)))
      .limit(1);

    const live = row && row.status !== "archived" && !row.erased;
    const gownRows = await tx
      .select({
        gownId: enquiryGowns.gownId,
        name: enquiryGowns.gownNameSnapshot,
        derivatives: gownImages.derivatives,
      })
      .from(enquiryGowns)
      .leftJoin(
        gownImages,
        and(
          eq(gownImages.gownId, enquiryGowns.gownId),
          eq(gownImages.isHero, true),
        ),
      )
      .where(eq(enquiryGowns.enquiryId, row?.id ?? NIL_UUID))
      .orderBy(asc(enquiryGowns.gownNameSnapshot), asc(enquiryGowns.gownId));

    if (row && actor) {
      await tx.insert(auditLog).values({
        occurredAt: new Date(),
        actorUserId: actor.staff.id,
        action: "enquiry.view",
        entityType: "enquiry",
        entityId: row.id,
        detail: { via: "short_link" },
        ip: inetOrNull(ip),
      });
      return { kind: "staff", enquiryId: row.id } as const;
    }
    if (!live) return { kind: "closed" } as const;
    return {
      kind: "open",
      view: {
        reference: row.reference,
        gowns: gownRows.map((g) => ({ name: g.name, imageUrl: photoUrl(g.derivatives) })),
      },
    } as const;
  });
}

/**
 * POST /e/:token/channel: last write wins. Archived, erased and unknown
 * tokens match no row, so the caller cannot tell them apart (always 204).
 */
export async function recordChatChannel(
  token: string,
  channel: ChatChannel,
  database: Database = defaultDb,
): Promise<void> {
  await database
    .update(enquiries)
    .set({ chatChannelChosen: channel })
    .where(
      and(
        eq(enquiries.tokenHash, hashLinkToken(token)),
        inArray(enquiries.status, ["new", "read"]),
        not(isErased),
      ),
    );
}
