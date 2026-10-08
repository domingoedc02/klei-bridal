import { v7 as uuidv7 } from "uuid";

/**
 * Every primary key in this schema is a UUIDv7, generated here in
 * application code — never `gen_random_uuid()` (that's v4, which
 * fragments the B-tree) and never an autoincrement int (which leaks
 * catalogue/enquiry volume in a public URL). v7 is time-ordered, so
 * index locality holds even though the value is opaque (spec/data-model).
 */
export function generateId(): string {
  return uuidv7();
}
