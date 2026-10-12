import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// KBS-11-1: every exported HTTP method under app/api is wrapped in
// withPipeline — a bare handler skips the body limit, rate limit, error
// mapper and headers, and nothing else would notice.

const ROOT = join(__dirname, "..", "..", "..");
const METHODS = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS";

/** Exported HTTP methods in a route module that are NOT `= withPipeline(`. */
export function unwrappedMethods(source: string): string[] {
  const exported = new RegExp(
    `export\\s+(?:async\\s+function\\s+|function\\s+|const\\s+|let\\s+|var\\s+)(${METHODS})\\b`,
    "g",
  );
  const wrapped = new RegExp(`export\\s+const\\s+(${METHODS})\\s*=\\s*withPipeline\\s*\\(`, "g");
  const ok = new Set([...source.matchAll(wrapped)].map((m) => m[1]));
  const bad = [...source.matchAll(exported)].map((m) => m[1] ?? "").filter((m) => !ok.has(m));
  // `export { GET } from` / `export { handler as GET }` re-exports dodge the
  // check above, so they are refused outright.
  const reexport = new RegExp(`export\\s*\\{[^}]*\\b(${METHODS})\\b[^}]*\\}`, "g");
  return [...bad, ...[...source.matchAll(reexport)].map((m) => `${m[1]} (re-export)`)];
}

function routeFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return /^route\.(ts|tsx|js)$/.test(entry.name) ? [full] : [];
  });
}

describe("app/api route handlers use withPipeline", () => {
  it("wraps every exported HTTP method in every app/api/**/route.ts", () => {
    const offenders = routeFiles(join(ROOT, "app", "api")).flatMap((file) =>
      unwrappedMethods(readFileSync(file, "utf8")).map((m) => `${relative(ROOT, file)}: ${m}`),
    );
    expect(offenders).toEqual([]);
  });

  it("detects a bare handler, a bare const and a re-export", () => {
    expect(
      unwrappedMethods(`export async function POST(req: Request) { return new Response(); }`),
    ).toEqual(["POST"]);
    expect(unwrappedMethods(`export const GET = async () => new Response();`)).toEqual(["GET"]);
    expect(unwrappedMethods(`export { handler as DELETE };`)).toEqual(["DELETE (re-export)"]);
  });

  it("accepts wrapped handlers and ignores non-method exports", () => {
    const source = [
      `export const dynamic = "force-dynamic";`,
      `export const POST = withPipeline(async (req) => Response.json({}), { auth: "public", rateLimit: budgets.enquirySubmit });`,
      `export const GET = withPipeline(handler, { auth: "staff", rateLimit: null });`,
    ].join("\n");
    expect(unwrappedMethods(source)).toEqual([]);
  });
});

// KBS-11-3: `csrf: false` turns off the only CSRF check a route has. It is
// allowed on the stateless CSP-report sink and nowhere else.
// The mail webhook is authenticated by its Svix HMAC signature, not a cookie (KBS-33 Security).
const CSRF_OFF_ALLOWED = ["app/api/csp-report/route.ts", "app/api/webhooks/mail/route.ts"];

describe("csrf: false allowlist", () => {
  it("only the CSP sink and the signed mail webhook set csrf: false", () => {
    const offenders = routeFiles(join(ROOT, "app", "api"))
      .filter((file) => /\bcsrf\s*:\s*false\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file).split("\\").join("/"));
    expect(offenders).toEqual(CSRF_OFF_ALLOWED);
  });
});
