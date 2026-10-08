import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

// Review finding on PR #5 (KBS-6): a "use client" module could import
// src/config/env.ts — which holds DATABASE_URL, SESSION_SECRET and the
// mail keys — and lint still passed. These cases lint an in-memory probe
// at a path inside each browser-bundled zone, so the boundary rule is
// proven to fire rather than assumed to exist.

const eslint = new ESLint({ cwd: ROOT });

async function boundaryErrors(file: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath: join(ROOT, file) });
  return (result?.messages ?? []).filter((m) => m.ruleId === "boundaries/element-types");
}

describe("module boundaries (spec/file-structure)", () => {
  it.each([
    "src/client/hooks/__probe.ts",
    "src/components/ui/__probe.tsx",
    "src/components/public/__probe.tsx",
    "src/components/admin/__probe.tsx",
  ])("refuses an import of src/config from %s", async (file) => {
    const source = `"use client";\nimport { env } from "@/config/env";\nexport const probe = env.SITE_URL;\n`;

    const errors = await boundaryErrors(file, source);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("must never import src/config/**");
  });

  it("still lets server code import src/config", async () => {
    const source = `import { env } from "@/config/env";\nexport const probe = env.SITE_URL;\n`;

    const errors = await boundaryErrors("src/server/services/__probe.ts", source);

    expect(errors).toEqual([]);
  });
});
