import { describe, expect, it, vi } from "vitest";

import {
  cancelPendingStaffInviteMail,
  encryptStaffMailPayload,
  enqueueStaffInviteMail,
  processStaffInviteMail,
  rewrapStaffMailPayload,
} from "@/server/mail/staff-invite-outbox";

const payload = {
  to: "staff@example.test",
  subject: "Set password",
  text: "https://example.test/admin/reset-password?token=secret-token",
  html: '<a href="https://example.test/admin/reset-password?token=secret-token">Set password</a>',
};

function updateDb() {
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { db: { update } as never, update, set, where };
}

function pendingDb(attempts = 0) {
  const updateState = updateDb();
  const tx = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: async () => [
              {
                id: "outbox-1",
                payload: encryptStaffMailPayload(payload),
                attempts,
                keyVersion: 1,
                idempotencyKey: "staff-invite:test",
              },
            ],
          }),
        }),
      }),
    })),
    update: updateState.update,
  };
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    update: updateState.update,
  };
  return {
    db: db as never,
    update: updateState.update,
    set: updateState.set,
    where: updateState.where,
  };
}

describe("staff invite mail outbox", () => {
  it("rewraps payload with current key version", () => {
    const original = encryptStaffMailPayload(payload, 1);
    const rotated = rewrapStaffMailPayload(original, 1);
    expect(rotated).not.toEqual(original);
    expect(rotated).toHaveLength(original.length);
  });
  it("encrypts payload and does not retain plaintext token bytes", () => {
    const encrypted = encryptStaffMailPayload(payload);

    expect(encrypted).not.toEqual(Buffer.from(JSON.stringify(payload)));
    expect(encrypted.toString("utf8")).not.toContain("secret-token");
    expect(encryptStaffMailPayload(payload)).not.toEqual(encrypted);
  });

  it("enqueues encrypted mail with caller idempotency key", async () => {
    const values = vi.fn(async (...args: [unknown]) => {
      void args;
    });
    const tx = { insert: vi.fn(() => ({ values })) } as never;

    await enqueueStaffInviteMail(tx, {
      tokenId: "token-1",
      idempotencyKey: "staff-invite:hash-1",
      email: payload,
    });

    expect(values).toHaveBeenCalledOnce();
    const row = values.mock.calls[0]?.[0] as unknown as { payload: Buffer } & Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      tokenId: "token-1",
      idempotencyKey: "staff-invite:hash-1",
      keyVersion: 1,
    });
    expect(row.payload).toBeInstanceOf(Buffer);
    expect(row.payload.toString("utf8")).not.toContain("secret-token");
  });

  it("marks a void-returning provider delivery sent and clears payload", async () => {
    const { db, update, set } = pendingDb();
    const send = vi.fn(
      async (_message: typeof payload, _options?: { idempotencyKey?: string }) => undefined,
    );

    await expect(
      processStaffInviteMail({ db, send, now: () => new Date("2026-10-16T00:00:00Z") }),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(payload, { idempotencyKey: expect.any(String) });
    expect(update).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent", payload: null, providerMessageId: null }),
    );
  });

  it("stores provider ID and clears payload after success", async () => {
    const { db, set } = pendingDb();
    const send = vi.fn(
      async (_message: typeof payload, _options?: { idempotencyKey?: string }) => ({
        providerMessageId: "provider-1",
      }),
    );

    await processStaffInviteMail({ db, send });

    expect(set).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "sent", payload: null, providerMessageId: "provider-1" }),
    );
  });

  it("schedules retry after provider failure without persisting provider details", async () => {
    const { db, set } = pendingDb();
    const send = vi.fn(async (_message: typeof payload, _options?: { idempotencyKey?: string }) => {
      throw new Error("provider secret detail");
    });
    const now = new Date("2026-10-16T00:00:00Z");

    await processStaffInviteMail({ db, send, now: () => now });

    expect(set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        availableAt: new Date(now.getTime() + 60_000),
        lastErrorCode: "provider_rejected",
      }),
    );
    expect(set.mock.calls.flat().join(" ")).not.toContain("provider secret detail");
  });

  it("revokes token and records redacted audit after terminal failure", async () => {
    const updateState = updateDb();
    const claimTx = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: async () => [
                {
                  id: "outbox-1",
                  payload: encryptStaffMailPayload(payload),
                  attempts: 2,
                  keyVersion: 1,
                  idempotencyKey: "staff-invite:test",
                },
              ],
            }),
          }),
        }),
      })),
      update: updateState.update,
    };
    const failureTx = {
      select: vi.fn(() => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              for: async () => [{ tokenId: "token-1", staffUserId: "staff-1" }],
            }),
          }),
        }),
      })),
      update: updateState.update,
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    };
    let transactionCount = 0;
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(transactionCount++ === 0 ? claimTx : failureTx),
      ),
      update: updateState.update,
    } as never;
    const send = vi.fn(async (_message: typeof payload, _options?: { idempotencyKey?: string }) => {
      throw new Error("provider secret detail");
    });

    await processStaffInviteMail({ db, send });

    expect(updateState.set).toHaveBeenCalledWith(
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
    expect(updateState.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        payload: null,
        lastErrorCode: "provider_rejected",
      }),
    );
    expect(updateState.set.mock.calls.flat().join(" ")).not.toContain("provider secret detail");
    expect(failureTx.insert).toHaveBeenCalledOnce();
  });

  it("cancels pending rows for replaced token IDs", async () => {
    const { update, set, where } = updateDb();
    const tx = { update } as never;

    await cancelPendingStaffInviteMail(tx, ["token-1", "token-2"]);
    await cancelPendingStaffInviteMail(tx, []);

    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", payload: null }),
    );
    expect(where).toHaveBeenCalledOnce();
  });
});
