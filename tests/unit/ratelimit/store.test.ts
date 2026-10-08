import type Redis from "iovalkey";
import { describe, expect, it, vi } from "vitest";
import { budgets } from "../../../src/server/ratelimit/budgets";
import { createValkeyStore, valkeyOptions } from "../../../src/server/ratelimit/store";

function fakeClient(replies: unknown) {
  const chain = {
    incr: vi.fn(() => chain),
    expire: vi.fn(() => chain),
    ttl: vi.fn(() => chain),
    exec: vi.fn(async () => replies),
  };
  return { client: { multi: () => chain } as unknown as Redis, chain };
}

describe("Valkey rate-limit store", () => {
  it("INCRs, sets the window only on first hit (EXPIRE NX), and reads the TTL in one MULTI", async () => {
    const { client, chain } = fakeClient([
      [null, 3],
      [null, 0],
      [null, 412],
    ]);
    const hit = await createValkeyStore(client).hit("rl:enquiry-submit:ip:1.2.3.4", 600);
    expect(hit).toEqual({ count: 3, ttlSec: 412 });
    expect(chain.expire).toHaveBeenCalledWith("rl:enquiry-submit:ip:1.2.3.4", 600, "NX");
  });

  it("throws on a command error or an aborted transaction, so failMode decides", async () => {
    const failed = fakeClient([
      [new Error("OOM"), null],
      [null, 0],
      [null, 1],
    ]).client;
    await expect(createValkeyStore(failed).hit("k", 60)).rejects.toThrow("OOM");
    const aborted = fakeClient(null).client;
    await expect(createValkeyStore(aborted).hit("k", 60)).rejects.toThrow(/empty MULTI/);
  });

  it("bounds an outage: short connect/command timeouts, one retry", () => {
    expect(valkeyOptions).toMatchObject({
      connectTimeout: 1000,
      commandTimeout: 500,
      maxRetriesPerRequest: 1,
    });
  });
});

describe("budgets (spec/security → Rate limiting)", () => {
  it("matches the signed-off limits, windows and fail modes", () => {
    const table = Object.values(budgets).map((b) => [
      b.name,
      b.dimension,
      b.limit,
      b.windowSec,
      b.failMode,
      b.onExceeded,
    ]);
    expect(table).toEqual([
      ["enquiry-submit", "ip", 5, 600, "closed", "429"],
      ["send-my-list", "ip", 5, 3600, "closed", "429"],
      ["login", "ip", 10, 900, "closed", "429"],
      ["login", "account", 5, 900, "closed", "429"],
      ["enquiry-link", "ip", 30, 60, "open", "429"],
      ["enquiry-channel", "ip", 20, 60, "open", "silent-204"],
      ["admin-write", "session", 120, 60, "open", "429"],
    ]);
  });
});
