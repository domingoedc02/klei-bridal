export const FAVOURITES_KEY = "kbs.favourites.v1";
export const CONTACT_KEY = "kbs.contact.v1";

export type ContactDetails = {
  firstName: string;
  lastName: string;
  contactNumber: string;
  email: string;
};

function read<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function getFavouriteIds(): string[] {
  return read<string[]>(
    FAVOURITES_KEY,
    [],
    (value): value is string[] =>
      Array.isArray(value) && value.every((id) => typeof id === "string" && id.length <= 100),
  );
}

export function removeFavourite(id: string): void {
  try {
    window.localStorage.setItem(
      FAVOURITES_KEY,
      JSON.stringify(getFavouriteIds().filter((favourite) => favourite !== id)),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: FAVOURITES_KEY }));
  } catch {
    // Blocked storage is a normal browser state. Keep form usable.
  }
}

export const FAVOURITE_NAMES_KEY = "kbs.favourite-names.v1";

/**
 * Display names for favourited ids, `{ [id]: name }`. Catalogue pages write
 * bounded server-rendered names; this remains untrusted and chatHandoff re-validates.
 * Null when any id lacks a name.
 */
export function cacheFavouriteNames(gowns: Array<{ id: string; name: string }>): void {
  try {
    const current = read<Record<string, unknown>>(
      FAVOURITE_NAMES_KEY,
      {},
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
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
      )
        next[gown.id] = gown.name;
    }
    window.localStorage.setItem(FAVOURITE_NAMES_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage keeps favourites usable; confirmation omits hand-offs.
  }
}

export function getFavouriteNames(ids: string[]): string[] | null {
  const names = read<Record<string, unknown>>(
    FAVOURITE_NAMES_KEY,
    {},
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  const picked = ids.map((id) =>
    Object.prototype.hasOwnProperty.call(names, id) ? names[id] : undefined,
  );
  return picked.every((name): name is string => typeof name === "string") ? picked : null;
}

export function getContactDetails(): ContactDetails {
  return read<ContactDetails>(
    CONTACT_KEY,
    { firstName: "", lastName: "", contactNumber: "", email: "" },
    (value): value is ContactDetails => {
      if (typeof value !== "object" || value === null) return false;
      const record = value as Record<string, unknown>;
      return ["firstName", "lastName", "contactNumber", "email"].every(
        (key) => typeof record[key] === "string" && (record[key] as string).length <= 254,
      );
    },
  );
}
