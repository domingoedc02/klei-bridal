import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/config/env";

import * as schema from "./schema";

/**
 * THE only file that constructs a connection (spec/file-structure rule 3).
 * Pool max 10 — this box also runs Postgres itself (decision/vps-capacity).
 * Nothing else calls `postgres(...)`; every other module imports `db`
 * from here.
 */
const queryClient = postgres(env.DATABASE_URL, { max: 10 });

export const db = drizzle(queryClient, { schema });

export type Database = typeof db;
