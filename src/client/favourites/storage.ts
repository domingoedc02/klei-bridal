import { z } from "zod";

export const FAVOURITES_KEY = "kbs.favourites.v1";
export const CONTACT_KEY = "kbs.contact.v1";
export const FAVOURITE_NAMES_KEY = "kbs.favourite-names.v1";

const favouriteSchema = z.object({ gown_id: z.string().uuid(), added_at: z.string().datetime() }).strict();
const favouritesSchema = z.array(favouriteSchema).max(50);
const contactSchema = z
  .object({
    first_name: z.string().max(100),
    last_name: z.string().max(100),
    contact_number: z.string().max(100),
    email: z.string().max(254),
  })
  .strict();

type StoredFavourite = z.infer<typeof favouriteSchema>;
type StoredContact = z.infer<typeof contactSchema>;

export type ContactDetails = {
  firstName: string;
  lastName: string;
  contactNumber: string;
  email: string;
};

const memoryStore: Record<string, string> = {};
const memoryFallbackKeys = new Set<string>();

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(key: string): string | null {
  const storage = getStorage();
  if (!storage || memoryFallbackKeys.has(key)) return memoryStore[key] ?? null;
  try {
    return storage.getItem(key);
  } catch {
    memoryFallbackKeys.add(key);
    return memoryStore[key] ?? null;
  }
}

function writeRaw(key: string, value: string): boolean {
  const storage = getStorage();
  if (!storage) {
    memoryFallbackKeys.add(key);
    memoryStore[key] = value;
    return false;
  }
  try {
    storage.setItem(key, value);
    memoryFallbackKeys.delete(key);
    memoryStore[key] = value;
    return true;
  } catch {
    memoryFallbackKeys.add(key);
    memoryStore[key] = value;
    return false;
  }
}

function removeRaw(key: string): boolean {
  const storage = getStorage();
  delete memoryStore[key];
  memoryFallbackKeys.delete(key);
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function parsed<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const raw = readRaw(key);
    if (!raw) return fallback;
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}

function changed(key: string) {
  try {
    window.dispatchEvent(new StorageEvent("storage", { key }));
  } catch {
    // Event dispatch is a convenience for same-tab listeners, not persistence.
  }
}

export function getFavourites(): StoredFavourite[] {
  return parsed(FAVOURITES_KEY, favouritesSchema, []);
}

export function getFavouriteIds(): string[] {
  return getFavourites().map(({ gown_id }) => gown_id);
}

export function addFavourite(id: string): boolean {
  if (!z.string().uuid().safeParse(id).success) return false;
  const current = getFavourites().filter((favourite) => favourite.gown_id !== id);
  const next = [...current, { gown_id: id, added_at: new Date().toISOString() }];
  const persisted = writeRaw(FAVOURITES_KEY, JSON.stringify(next));
  changed(FAVOURITES_KEY);
  return persisted;
}

export function removeFavourite(id: string): boolean {
  const next = getFavourites().filter((favourite) => favourite.gown_id !== id);
  const persisted = writeRaw(FAVOURITES_KEY, JSON.stringify(next));
  changed(FAVOURITES_KEY);
  return persisted;
}

export function clearFavourites(): boolean {
  const removed = removeRaw(FAVOURITES_KEY);
  changed(FAVOURITES_KEY);
  return removed;
}

export function saveContactDetails(details: ContactDetails): boolean {
  const value: StoredContact = {
    first_name: details.firstName,
    last_name: details.lastName,
    contact_number: details.contactNumber,
    email: details.email,
  };
  const valid = contactSchema.safeParse(value);
  if (!valid.success) return false;
  return writeRaw(CONTACT_KEY, JSON.stringify(value));
}

export function clearContactDetails(): boolean {
  return removeRaw(CONTACT_KEY);
}

export function getContactDetails(): ContactDetails {
  const value = parsed(CONTACT_KEY, contactSchema, {
    first_name: "",
    last_name: "",
    contact_number: "",
    email: "",
  });
  return {
    firstName: value.first_name,
    lastName: value.last_name,
    contactNumber: value.contact_number,
    email: value.email,
  };
}

/** Cache bounded server-rendered names for the enquiry confirmation hand-off. */
export function cacheFavouriteNames(gowns: Array<{ id: string; name: string }>): void {
  try {
    const current = parsed(FAVOURITE_NAMES_KEY, z.record(z.string(), z.string()), {});
    const next = { ...current };
    for (const gown of gowns) {
      if (
        typeof gown.id === "string" &&
        gown.id.length <= 100 &&
        typeof gown.name === "string" &&
        gown.name.trim() === gown.name &&
        gown.name.length > 0 &&
        gown.name.length <= 100 &&
        !/[<>]/.test(gown.name) &&
        !/[\u0000-\u001f\u007f-\u009f]/.test(gown.name)
      ) {
        next[gown.id] = gown.name;
      }
    }
    writeRaw(FAVOURITE_NAMES_KEY, JSON.stringify(next));
  } catch {
    // Unavailable storage keeps favourites usable; confirmation omits hand-offs.
  }
}

export function getFavouriteNames(ids: string[]): string[] | null {
  const names = parsed(FAVOURITE_NAMES_KEY, z.record(z.string(), z.string()), {});
  const picked = ids.map((id) => names[id]);
  return picked.every((name): name is string => typeof name === "string") ? picked : null;
}
