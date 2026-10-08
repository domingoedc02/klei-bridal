/**
 * Idempotent seed: vocabulary (silhouettes, materials, collections) and
 * `settings` defaults. Safe to re-run — every insert is `ON CONFLICT DO
 * NOTHING` keyed on the unique name/key, never duplicating rows
 * (spec/file-structure: "Reference data... ships as a separate
 * idempotent seed migration" — this is that, kept out of
 * drizzle/migrations/ on purpose).
 *
 * Two minimal sample gowns — one in stock, one made-to-order (KBS-9
 * AC-10) — with no images: `gowns.hero_image_id` is nullable and a gown
 * may have zero `gown_images` rows. They are seeded as `draft`, so a seed
 * run anywhere never puts them in the public catalogue. The fuller
 * fixture set with photographs (spec/setup/seed) depends on the image
 * pipeline running `sharp`, and lands with KBS-13, appending to this file
 * rather than replacing it.
 *
 * Ids come from generateId() (UUIDv7) like every other row, never
 * gen_random_uuid() (v4) — see src/server/db/uuid.ts.
 */
import postgres from "postgres";

import { env } from "../../src/config/env";
import { generateId } from "../../src/server/db/uuid";

const SILHOUETTES = ["A-line", "Ball gown", "Mermaid", "Trumpet", "Sheath", "Empire"];
const MATERIALS = ["Satin", "Mikado", "Lace", "Tulle", "Glitter", "Organza", "Crepe"];
const COLLECTIONS = ["Minimalist", "Modern", "Lace", "Tulle", "New Arrivals"];

// Keyed on slug, so a re-run is a no-op. `is_in_stock` is set explicitly
// on both — the column defaults to false (made-to-order), and AC-10 asks
// for one of each.
const SAMPLE_GOWNS = [
  {
    slug: "sample-in-stock-a-line",
    name: "Sample — In-stock A-line",
    silhouette: "A-line",
    isInStock: true,
  },
  {
    slug: "sample-made-to-order-mermaid",
    name: "Sample — Made-to-order Mermaid",
    silhouette: "Mermaid",
    isInStock: false,
  },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Team-written placeholders so unwritten client copy can never block
// launch (spec/data-model) — swapped for the client's own wording via
// admin settings (KBS-25) whenever it arrives.
const NOTICE_COPY = {
  comfortable:
    "Your wedding date gives us plenty of time to prepare your gown. We'll be in touch shortly after you enquire.",
  rush: "Your wedding date is coming up — rush production may be possible. We'll confirm availability when we reply to your enquiry.",
  in_stock_only:
    "Your wedding date is close. Only in-stock gowns can be guaranteed in time — we'll let you know what's possible when we reply.",
};

async function main() {
  const sql = postgres(env.DATABASE_URL, { max: 1 });

  try {
    console.log("Seeding vocabulary...");

    for (const name of SILHOUETTES) {
      await sql`
        INSERT INTO silhouettes (id, name, slug) VALUES (${generateId()}, ${name}, ${slugify(name)})
        ON CONFLICT (lower(trim(name))) DO NOTHING
      `;
    }

    for (const name of MATERIALS) {
      await sql`
        INSERT INTO materials (id, name, slug) VALUES (${generateId()}, ${name}, ${slugify(name)})
        ON CONFLICT (lower(trim(name))) DO NOTHING
      `;
    }

    for (const name of COLLECTIONS) {
      await sql`
        INSERT INTO collections (id, name, slug) VALUES (${generateId()}, ${name}, ${slugify(name)})
        ON CONFLICT (lower(trim(name))) DO NOTHING
      `;
    }

    console.log("Seeding sample gowns...");

    for (const gown of SAMPLE_GOWNS) {
      await sql`
        INSERT INTO gowns (id, slug, name, silhouette_id, status, price_status, is_in_stock)
        SELECT ${generateId()}, ${gown.slug}, ${gown.name}, s.id, 'draft', 'on_request', ${gown.isInStock}
        FROM silhouettes s WHERE lower(trim(s.name)) = lower(trim(${gown.silhouette}))
        ON CONFLICT (slug) DO NOTHING
      `;
    }

    console.log("Seeding settings...");

    const settingsRows: Array<{
      key: string;
      value: string | number | boolean | Record<string, string> | null;
    }> = [
      // Confirmed 2-3 month lead time (the client's own words). 26/10 or
      // 4-6 months anywhere else in team memory is stale — this is the
      // number that actually seeds the database.
      { key: "lead_time_comfortable_weeks", value: 13 },
      { key: "lead_time_rush_floor_weeks", value: 5 },
      { key: "lead_time_notice_copy", value: NOTICE_COPY },
      // Retention is INDEFINITE by the client's own decision — the flag
      // ships off, but the columns exist as the switch if that changes.
      { key: "retention_enabled", value: false },
      { key: "retention_months", value: 24 },
      // UNCONFIRMED ASSUMPTION, not fact — flagged here and in
      // spec/data-model, not quietly presented as a client answer.
      { key: "studio_timezone", value: "Asia/Manila" },
      { key: "default_currency", value: env.DEFAULT_CURRENCY },
      // Bootstrap defaults only (spec/setup) — the runtime source of
      // truth is this very table, editable in admin (KBS-25) without a
      // deploy. Empty string (not SQL/JSON null — `value` is NOT NULL)
      // means "not yet configured" until the client supplies the real
      // values.
      { key: "studio_whatsapp_number", value: env.WHATSAPP_NUMBER ?? "" },
      { key: "studio_viber_number", value: env.VIBER_NUMBER ?? "" },
      { key: "studio_facebook_page", value: env.MESSENGER_PAGE_HANDLE ?? "" },
    ];

    for (const row of settingsRows) {
      await sql`
        INSERT INTO settings (key, value) VALUES (${row.key}, ${sql.json(row.value)})
        ON CONFLICT (key) DO NOTHING
      `;
    }

    console.log("Seed complete.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
