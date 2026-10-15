#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { db } from "@/server/db/client";
import { gownImages } from "@/server/db/schema";
import { variantsRoot } from "@/server/media/variants";
import { missingDerivativePaths } from "@/server/media/derivativeVerification";

async function files(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.add(relative(root, path));
    }
  }
  await walk(root);
  return found;
}

export async function verifyImageDerivatives(): Promise<{ checked: number; missing: string[] }> {
  const rows = await db.select({ originalPath: gownImages.originalPath }).from(gownImages);
  const missing = missingDerivativePaths(rows, await files(variantsRoot()));
  return { checked: rows.length, missing };
}

async function main(): Promise<void> {
  const result = await verifyImageDerivatives();
  process.stdout.write(
    JSON.stringify({ checked: result.checked, missing: result.missing.length }) + "\n",
  );
  if (result.missing.length) {
    for (const path of result.missing.slice(0, 20)) process.stderr.write(`${path}\n`);
    process.exitCode = 1;
  }
  await db.$client.end();
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await db.$client.end().catch(() => undefined);
    process.exitCode = 1;
  });
