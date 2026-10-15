#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { db } from "@/server/db/client";
import { gownImages } from "@/server/db/schema";
import { derivativePaths, variantsRoot } from "@/server/media/variants";

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

async function main(): Promise<void> {
  const rows = await db.select({ originalPath: gownImages.originalPath }).from(gownImages);
  const onDisk = await files(variantsRoot());
  const missing = rows.flatMap(({ originalPath }) =>
    derivativePaths(originalPath).filter((path) => !onDisk.has(path)),
  );

  process.stdout.write(JSON.stringify({ checked: rows.length, missing: missing.length }) + "\n");
  if (missing.length) {
    for (const path of missing.slice(0, 20)) process.stderr.write(`${path}\n`);
    process.exitCode = 1;
  }
  await db.$client.end();
}

main().catch(async (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await db.$client.end().catch(() => undefined);
  process.exitCode = 1;
});
