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
