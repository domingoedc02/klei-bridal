// Slug helpers — public addressing for gowns and vocabulary rows, never
// the primary key (spec/data-model). Server remains authority on uniqueness.

/** "Amélie Ball Gown!" → "amelie-ball-gown" */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
}
