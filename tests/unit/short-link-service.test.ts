import { describe, expect, it, vi } from "vitest";

import { resolveShortLink } from "@/server/services/short-link";
import { renderClosed } from "@/server/short-link/render";

const TOKEN = "A".repeat(43);
const SITE_URL = "http://localhost:3000";

function databaseFor(row: unknown, gowns: unknown[] = []) {
  const firstQuery = {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => [row]) })),
    })),
  };
  const secondQuery = {
    from: vi.fn(() => ({
      leftJoin: vi.fn(() => ({
        where: vi.fn(() => ({ orderBy: vi.fn(async () => gowns) })),
      })),
    })),
  };
  const tx = {
    select: vi.fn().mockReturnValueOnce(firstQuery).mockReturnValueOnce(secondQuery),
  };
  return { transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)) };
}

describe("short-link erased responses", () => {
  it("maps erased enquiry to the same closed result as an unknown token", async () => {
    const erasedDatabase = databaseFor({
      id: "11111111-1111-4111-8111-111111111111",
      reference: "KB-ERAS-ED01",
      status: "new",
      erased: true,
    });
    const unknownDatabase = databaseFor(undefined);

    const [erased, unknown] = await Promise.all([
      resolveShortLink(TOKEN, null, null, erasedDatabase as never),
      resolveShortLink(TOKEN, null, null, unknownDatabase as never),
    ]);

    expect(erased).toEqual({ kind: "closed" });
    expect(unknown).toEqual({ kind: "closed" });
    expect(renderClosed(SITE_URL)).not.toContain("KB-ERAS-ED01");
    expect(renderClosed(SITE_URL)).not.toContain("11111111-1111-4111-8111-111111111111");
  });
});
