import { defineConfig } from "drizzle-kit";

import { env } from "./src/config/env";

// `drizzle-kit generate` is used to DRAFT a migration from the schema
// change — the generated SQL is then hand-read and the committed file
// in drizzle/migrations is what actually runs in production
// (spec/conventions: "the generated file is a draft, not the
// deliverable"). `drizzle-kit push` is never used against any database
// that matters. Run via `pnpm db:generate`, which sets the react-server
// condition so src/config/env.ts ("server-only") can load here.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
