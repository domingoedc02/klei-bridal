import { beforeEach, describe, expect, it, vi } from "vitest";

type Store = {
  data: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function makeStorage(options: { accessThrows?: boolean; writeThrows?: boolean } = {}): Store {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.writeThrows) throw new Error("QuotaExceededError");
      data.set(key, value);
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

async function load(storage: Store | null) {
  const events: string[] = [];
  const windowValue = {
    ...(storage ? { localStorage: storage } : {}),
    dispatchEvent(event: Event) {
      events.push((event as StorageEvent).key ?? "");
      return true;
    },
    StorageEvent: class extends Event {
      readonly key: string | null;
      constructor(_: string, init: StorageEventInit = {}) {
        super("storage");
        this.key = init.key ?? null;
      }
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowValue });
  Object.defineProperty(globalThis, "StorageEvent", {
    configurable: true,
    value: windowValue.StorageEvent,
  });
  vi.resetModules();
  const storageModule = await import("@/client/favourites/storage");
  return { storageModule, events };
}

describe("defensive favourites storage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("stores timestamped favourite entries and dispatches sync events", async () => {
    const storage = makeStorage();
    const { storageModule, events } = await load(storage);
    const id = "11111111-1111-4111-8111-111111111111";

    expect(storageModule.addFavourite(id)).toBe(true);
    expect(storageModule.getFavouriteIds()).toEqual([id]);
    expect(JSON.parse(storage.data.get(storageModule.FAVOURITES_KEY)!)).toEqual([
      { gown_id: id, added_at: expect.any(String) },
    ]);
    expect(events).toContain(storageModule.FAVOURITES_KEY);
  });

  it.each([
    ["malformed JSON", "{"],
    ["wrong shape", JSON.stringify(["11111111-1111-4111-8111-111111111111"])],
    ["invalid UUID", JSON.stringify([{ gown_id: "stale", added_at: new Date().toISOString() }])],
  ])("treats %s as empty", async (_, raw) => {
    const storage = makeStorage();
    storage.data.set("kbs.favourites.v1", raw);
    const { storageModule } = await load(storage);
    expect(storageModule.getFavourites()).toEqual([]);
  });

  it("falls back in memory when localStorage access throws", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage(): never {
          throw new Error("blocked");
        },
        dispatchEvent: () => true,
      },
    });
    vi.resetModules();
    const storageModule = await import("@/client/favourites/storage");
    const id = "22222222-2222-4222-8222-222222222222";
    expect(storageModule.addFavourite(id)).toBe(false);
    expect(storageModule.getFavouriteIds()).toEqual([id]);
  });

  it("keeps the session list when quota rejects a write", async () => {
    const { storageModule } = await load(makeStorage({ writeThrows: true }));
    const id = "33333333-3333-4333-8333-333333333333";
    expect(storageModule.addFavourite(id)).toBe(false);
    expect(storageModule.getFavouriteIds()).toEqual([id]);
  });

  it("handles cleared and evicted stores as empty", async () => {
    const storage = makeStorage();
    const { storageModule } = await load(storage);
    const id = "44444444-4444-4444-8444-444444444444";
    storageModule.addFavourite(id);
    storage.data.clear();
    expect(storageModule.getFavouriteIds()).toEqual([]);
  });

  it("clears contact details without clearing favourites", async () => {
    const storage = makeStorage();
    const { storageModule } = await load(storage);
    const id = "55555555-5555-4555-8555-555555555555";
    storageModule.addFavourite(id);
    expect(
      storageModule.saveContactDetails({
        firstName: "Maricel",
        lastName: "Bride",
        contactNumber: "09170000000",
        email: "maricel@example.com",
      }),
    ).toBe(true);
    expect(storageModule.clearContactDetails()).toBe(true);
    expect(storageModule.getContactDetails()).toEqual({
      firstName: "",
      lastName: "",
      contactNumber: "",
      email: "",
    });
    expect(storageModule.getFavouriteIds()).toEqual([id]);
    expect(JSON.parse(storage.data.get(storageModule.CONTACT_KEY) ?? "null")).toBeNull();
  });

  it("rejects invalid favourite ids without writing", async () => {
    const storage = makeStorage();
    const { storageModule } = await load(storage);
    expect(storageModule.addFavourite("not-an-id")).toBe(false);
    expect(storage.data.has(storageModule.FAVOURITES_KEY)).toBe(false);
  });
});
