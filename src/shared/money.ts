// Integer minor units <-> display, the ONLY formatter in the codebase.

/** "₱45,000.00" → 4500000; null for invalid or non-positive input. */
export function parsePriceToMinor(input: string): number | null {
  if (input.includes("-")) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.replace(/[^\d.]/g, ""));
  if (!match?.[1]) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** 4500000 → "PHP 45,000.00"; ISO code remains visible. */
export function formatMinor(minor: number, currency = "PHP"): string {
  const whole = new Intl.NumberFormat("en-PH").format(Math.trunc(minor / 100));
  return `${currency} ${whole}.${String(minor % 100).padStart(2, "0")}`;
}
