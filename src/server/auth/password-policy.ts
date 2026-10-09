import "server-only";

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { access } from "node:fs/promises";

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Source: SecLists Common-Credentials/100k-most-used-passwords-NCSC.txt.
 * Downloaded 2026-10-09 from the MIT-licensed SecLists repository and stored
 * compressed so it is server-only and does not enter browser bundles.
 */
const LIST_PATH = join(process.cwd(), "src/server/auth/data/common-passwords.txt.gz");
let listPath = LIST_PATH;
const NORMALIZED_OVERRIDES = new Set(["password123"]);
let commonPasswords: Promise<ReadonlySet<string>> | undefined;
let unavailableLogged = false;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function loadCommonPasswords(): Promise<ReadonlySet<string>> {
  const values = new Set<string>();
  await access(listPath);
  const lines = createInterface({ input: createReadStream(listPath).pipe(createGunzip()) });
  for await (const line of lines) {
    const value = line.trim().toLowerCase();
    if (value && !value.startsWith("#")) {
      values.add(value);
      values.add(normalize(value));
    }
  }
  return values;
}

function list(): Promise<ReadonlySet<string>> {
  return (commonPasswords ??= loadCommonPasswords().catch(() => {
    commonPasswords = undefined;
    if (!unavailableLogged) {
      unavailableLogged = true;
      console.error("password policy unavailable");
    }
    throw new Error("password policy unavailable");
  }));
}

/** Test-only cache reset; production callers never need to reload this list. */
export function resetPasswordPolicyCacheForTests(): void {
  commonPasswords = undefined;
  unavailableLogged = false;
  listPath = LIST_PATH;
}

export function setPasswordPolicyListPathForTests(path: string): void {
  commonPasswords = undefined;
  listPath = path;
}

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; reason: "weak_password" | "password_too_common" | "unavailable" };

export async function assertPasswordAllowed(
  password: string,
  options: { email?: string | null } = {},
): Promise<PasswordPolicyResult> {
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "weak_password" };
  try {
    const passwords = await list();
    const lower = password.toLowerCase();
    const local = options.email?.split("@", 1)[0]?.toLowerCase();
    if (
      passwords.has(lower) ||
      passwords.has(normalize(password)) ||
      NORMALIZED_OVERRIDES.has(normalize(password)) ||
      (local && local.length >= 3 && lower.includes(local)) ||
      lower.includes("klei bridal") ||
      lower.includes("kleibridal")
    ) {
      return { ok: false, reason: "password_too_common" };
    }
    return { ok: true };
  } catch (error) {
    console.error("password policy unavailable", error instanceof Error ? error.name : "unknown");
    return { ok: false, reason: "unavailable" };
  }
}
