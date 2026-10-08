import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

// Acceptance criteria (KBS-6): "Given the committed tree, when compared
// against spec/file-structure, then no `pages/` directory exists anywhere
// and every listed top-level path is present." This makes that check
// automatic rather than a one-time review observation.

describe("repository structure (spec/file-structure)", () => {
  it("has no App Router pages/ directory anywhere", () => {
    const disallowed: string[] = [];

    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") {
          continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "pages") disallowed.push(full);
          walk(full);
        }
      }
    }
    walk(ROOT);

    expect(disallowed).toEqual([]);
  });

  it.each([
    "app",
    "middleware.ts",
    "src/server/pipeline",
    "src/server/db/schema",
    "src/server/db/queries",
    "src/server/services",
    "src/server/mail",
    "src/server/media",
    "src/server/worker",
    "src/server/auth",
    "src/server/ratelimit",
    "src/shared",
    "src/client/favourites",
    "src/client/hooks",
    "src/components/ui",
    "src/components/public",
    "src/components/admin",
    "src/config/env.ts",
    "drizzle/migrations",
    "drizzle/seed",
    "tests/unit",
    "tests/integration",
    "tests/e2e",
    "public",
    "scripts",
    "package.json",
    "tsconfig.json",
    "next.config.ts",
    "eslint.config.mjs",
    ".env.example",
    ".gitignore",
    ".dockerignore",
  ])("has the required path: %s", (relativePath) => {
    expect(existsSync(join(ROOT, relativePath))).toBe(true);
  });
});
