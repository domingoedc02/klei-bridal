import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Against a REAL Postgres (spec/file-structure's testing convention),
 * migrated via `pnpm db:migrate` before this suite runs (CI does this;
 * locally: `docker compose up -d && pnpm db:migrate`). Asserts the
 * constraints that matter most in spec/data-model actually hold at the
 * database level, not only in application code — the whole point of
 * putting them there.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";

const sql = postgres(DATABASE_URL, { max: 5 });

// A dedicated password for this test run only, set directly on the
// `kbs_app` role the migration creates — never committed anywhere, and
// a real deploy sets this via KBS-34's own secret handling instead.
const KBS_APP_TEST_PASSWORD = `test_${randomUUID().replace(/-/g, "")}`;
let kbsAppSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  await sql.unsafe(`ALTER ROLE kbs_app WITH PASSWORD '${KBS_APP_TEST_PASSWORD}'`);
  const url = new URL(DATABASE_URL);
  url.username = "kbs_app";
  url.password = KBS_APP_TEST_PASSWORD;
  kbsAppSql = postgres(url.toString(), { max: 2 });
});

afterAll(async () => {
  await kbsAppSql?.end();
  await sql.end();
});

describe("gowns: price_status / price_minor CHECK (decision/pricing-display)", () => {
  it("rejects a priced gown with a null price", async () => {
    await expect(
      sql`INSERT INTO gowns (id, slug, name, price_status) VALUES (gen_random_uuid(), ${"check-fail-" + randomUUID()}, 'Test', 'priced')`,
    ).rejects.toThrow(/gowns_price_status_check/);
  });

  it("rejects a priced gown with a zero price", async () => {
    await expect(
      sql`INSERT INTO gowns (id, slug, name, price_status, price_minor) VALUES (gen_random_uuid(), ${"check-fail-" + randomUUID()}, 'Test', 'priced', 0)`,
    ).rejects.toThrow(/gowns_price_status_check/);
  });

  it("allows an on_request gown with a null price", async () => {
    const slug = "check-ok-" + randomUUID();
    const [row] = await sql`
      INSERT INTO gowns (id, slug, name, price_status) VALUES (gen_random_uuid(), ${slug}, 'Test', 'on_request')
      RETURNING id
    `;
    expect(row?.id).toBeTruthy();
    await sql`DELETE FROM gowns WHERE slug = ${slug}`;
  });

  it("allows a priced gown with a positive price", async () => {
    const slug = "check-ok-priced-" + randomUUID();
    const [row] = await sql`
      INSERT INTO gowns (id, slug, name, price_status, price_minor) VALUES (gen_random_uuid(), ${slug}, 'Test', 'priced', 4500000)
      RETURNING id
    `;
    expect(row?.id).toBeTruthy();
    await sql`DELETE FROM gowns WHERE slug = ${slug}`;
  });
});

describe("vocabulary tables: case-insensitive uniqueness (decision/category-vocabulary)", () => {
  it("rejects 'Lace' and 'lace' as two silhouette rows", async () => {
    const a = "Lace " + randomUUID();
    await sql`INSERT INTO silhouettes (id, name, slug) VALUES (gen_random_uuid(), ${a}, ${"slug-" + randomUUID()})`;
    await expect(
      sql`INSERT INTO silhouettes (id, name, slug) VALUES (gen_random_uuid(), ${a.toLowerCase()}, ${"slug-" + randomUUID()})`,
    ).rejects.toThrow(/silhouettes_name_lower_trim_idx/);
    await sql`DELETE FROM silhouettes WHERE lower(trim(name)) = ${a.toLowerCase().trim()}`;
  });
});

describe("gown_images: one hero per gown (partial unique index)", () => {
  it("rejects a second hero image for the same gown", async () => {
    const gownSlug = "hero-test-" + randomUUID();
    const [gown] = await sql`
      INSERT INTO gowns (id, slug, name, price_status) VALUES (gen_random_uuid(), ${gownSlug}, 'Hero test', 'on_request')
      RETURNING id
    `;
    const gownId = gown?.id as string;

    await sql`
      INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height)
      VALUES (gen_random_uuid(), ${gownId}, 0, true, '/orig/a.jpg', 100, 100)
    `;

    await expect(
      sql`
        INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height)
        VALUES (gen_random_uuid(), ${gownId}, 1, true, '/orig/b.jpg', 100, 100)
      `,
    ).rejects.toThrow(/gown_images_one_hero_per_gown_idx/);

    await sql`DELETE FROM gown_images WHERE gown_id = ${gownId}`;
    await sql`DELETE FROM gowns WHERE id = ${gownId}`;
  });
});

describe("sessions: token_hash uniqueness, indexed lookup shape", () => {
  it("rejects a duplicate token_hash", async () => {
    const [staff] = await sql`
      INSERT INTO staff_users (id, name, email, password_hash)
      VALUES (gen_random_uuid(), 'Test Staff', ${"staff-" + randomUUID() + "@example.com"}, 'x')
      RETURNING id
    `;
    const staffId = staff?.id as string;
    const tokenHash = "hash-" + randomUUID();

    await sql`
      INSERT INTO sessions (id, staff_user_id, token_hash, expires_at)
      VALUES (gen_random_uuid(), ${staffId}, ${tokenHash}, now() + interval '1 day')
    `;

    await expect(
      sql`
        INSERT INTO sessions (id, staff_user_id, token_hash, expires_at)
        VALUES (gen_random_uuid(), ${staffId}, ${tokenHash}, now() + interval '1 day')
      `,
    ).rejects.toThrow(/sessions_token_hash_idx/);

    await sql`DELETE FROM sessions WHERE staff_user_id = ${staffId}`;
    await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  });

  it("the leaver join: a disabled staff_user's session is excluded by the lookup predicate", async () => {
    const [staff] = await sql`
      INSERT INTO staff_users (id, name, email, password_hash, is_active)
      VALUES (gen_random_uuid(), 'Leaver', ${"leaver-" + randomUUID() + "@example.com"}, 'x', true)
      RETURNING id
    `;
    const staffId = staff?.id as string;
    const tokenHash = "hash-" + randomUUID();

    await sql`
      INSERT INTO sessions (id, staff_user_id, token_hash, expires_at)
      VALUES (gen_random_uuid(), ${staffId}, ${tokenHash}, now() + interval '1 day')
    `;

    // The exact predicate spec/security's session mechanism specifies.
    const activeLookup = async () => sql`
      SELECT s.id FROM sessions s
      JOIN staff_users su ON su.id = s.staff_user_id
      WHERE s.token_hash = ${tokenHash} AND s.revoked_at IS NULL
        AND s.expires_at > now() AND su.is_active = true
    `;

    expect((await activeLookup()).length).toBe(1);

    await sql`UPDATE staff_users SET is_active = false WHERE id = ${staffId}`;

    expect((await activeLookup()).length).toBe(0);

    await sql`DELETE FROM sessions WHERE staff_user_id = ${staffId}`;
    await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  });
});

describe("audit_log / price_history: append-only at the grant level", () => {
  it("kbs_app can INSERT and SELECT on audit_log", async () => {
    if (!kbsAppSql) throw new Error("kbs_app connection not ready");
    const entityId = randomUUID();
    await kbsAppSql`
      INSERT INTO audit_log (id, action, entity_type, entity_id) VALUES (gen_random_uuid(), 'gown.update', 'gown', ${entityId})
    `;
    const rows = await kbsAppSql`SELECT id FROM audit_log WHERE entity_id = ${entityId}`;
    expect(rows.length).toBe(1);
    await sql`DELETE FROM audit_log WHERE entity_id = ${entityId}`;
  });

  it("kbs_app cannot UPDATE audit_log", async () => {
    if (!kbsAppSql) throw new Error("kbs_app connection not ready");
    await expect(kbsAppSql`UPDATE audit_log SET action = 'x' WHERE false`).rejects.toThrow(
      /permission denied/,
    );
  });

  it("kbs_app cannot DELETE from audit_log", async () => {
    if (!kbsAppSql) throw new Error("kbs_app connection not ready");
    await expect(kbsAppSql`DELETE FROM audit_log WHERE false`).rejects.toThrow(/permission denied/);
  });

  it("kbs_app cannot UPDATE or DELETE price_history", async () => {
    if (!kbsAppSql) throw new Error("kbs_app connection not ready");
    await expect(kbsAppSql`UPDATE price_history SET old_status = 'x' WHERE false`).rejects.toThrow(
      /permission denied/,
    );
    await expect(kbsAppSql`DELETE FROM price_history WHERE false`).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("enquiry_gowns: composite PK and immutable snapshot shape", () => {
  it("snapshot columns survive independently of the live gown row", async () => {
    const gownSlug = "snapshot-test-" + randomUUID();
    const [gown] = await sql`
      INSERT INTO gowns (id, slug, name, price_status, price_minor)
      VALUES (gen_random_uuid(), ${gownSlug}, 'Original name', 'priced', 1000000)
      RETURNING id
    `;
    const gownId = gown?.id as string;

    const [enquiry] = await sql`
      INSERT INTO enquiries (
        id, reference, token_hash, wedding_date, source,
        lead_time_band_shown, lead_time_notice_shown
      ) VALUES (
        gen_random_uuid(), ${"REF-" + randomUUID()}, ${"tok-" + randomUUID()}, '2027-06-01', 'direct',
        'comfortable', 'Plenty of time.'
      )
      RETURNING id
    `;
    const enquiryId = enquiry?.id as string;

    await sql`
      INSERT INTO enquiry_gowns (enquiry_id, gown_id, gown_name_snapshot, price_minor_snapshot, price_status_snapshot, currency_snapshot)
      VALUES (${enquiryId}, ${gownId}, 'Original name', 1000000, 'priced', 'PHP')
    `;

    // The live gown's name changes...
    await sql`UPDATE gowns SET name = 'Renamed' WHERE id = ${gownId}`;

    // ...but the snapshot does not.
    const [snapshot] = await sql`
      SELECT gown_name_snapshot FROM enquiry_gowns WHERE enquiry_id = ${enquiryId}
    `;
    expect(snapshot?.gown_name_snapshot).toBe("Original name");

    await sql`DELETE FROM enquiry_gowns WHERE enquiry_id = ${enquiryId}`;
    await sql`DELETE FROM enquiries WHERE id = ${enquiryId}`;
    await sql`DELETE FROM gowns WHERE id = ${gownId}`;
  });
});

describe("seed: every vocabulary id is a UUIDv7 (src/server/db/uuid.ts)", () => {
  // Assumes `pnpm db:seed` ran before this suite (CI does; see ci.yml).
  // The version is the first hex digit of the third group.
  it.each(["silhouettes", "materials", "collections"])("%s ids are version 7", async (table) => {
    const rows = await sql`SELECT id FROM ${sql(table)}`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(String(row.id).charAt(14)).toBe("7");
    }
  });
});

describe("price_history: a gown with price history cannot be hard-deleted", () => {
  it("DELETE FROM gowns fails on the RESTRICT foreign key", async () => {
    const [staff] = await sql`
      INSERT INTO staff_users (id, name, email, password_hash)
      VALUES (gen_random_uuid(), 'Price Staff', ${"price-" + randomUUID() + "@example.com"}, 'x')
      RETURNING id
    `;
    const staffId = staff?.id as string;
    const [gown] = await sql`
      INSERT INTO gowns (id, slug, name, price_status, price_minor)
      VALUES (gen_random_uuid(), ${"restrict-test-" + randomUUID()}, 'Restrict test', 'priced', 500000)
      RETURNING id
    `;
    const gownId = gown?.id as string;
    await sql`
      INSERT INTO price_history (id, gown_id, old_price_minor, new_price_minor, old_status, new_status, actor_user_id)
      VALUES (gen_random_uuid(), ${gownId}, NULL, 500000, 'on_request', 'priced', ${staffId})
    `;

    await expect(sql`DELETE FROM gowns WHERE id = ${gownId}`).rejects.toThrow(
      /price_history_gown_id_gowns_id_fk/,
    );

    // Cleanup as the owner role (kbs_app cannot delete history).
    await sql`DELETE FROM price_history WHERE gown_id = ${gownId}`;
    await sql`DELETE FROM gowns WHERE id = ${gownId}`;
    await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  });
});

describe("_migrations: read-only to the app role", () => {
  it("kbs_app can read _migrations but cannot write it", async () => {
    if (!kbsAppSql) throw new Error("kbs_app connection not ready");
    const rows = await kbsAppSql`SELECT filename FROM _migrations`;
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      kbsAppSql`INSERT INTO _migrations (filename) VALUES ('9999_forged.sql')`,
    ).rejects.toThrow(/permission denied/);
    await expect(kbsAppSql`UPDATE _migrations SET filename = filename WHERE false`).rejects.toThrow(
      /permission denied/,
    );
    await expect(kbsAppSql`DELETE FROM _migrations WHERE false`).rejects.toThrow(
      /permission denied/,
    );
  });
});
