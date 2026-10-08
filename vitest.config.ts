import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `server-only` throws unless resolved under the react-server condition,
    // which only Next's server bundler sets. Tests import src/config/env.ts
    // directly, so stub it here; `next build` still enforces the guard.
    alias: {
      // tsconfig "paths", for src modules imported by tests (KBS-27).
      "@/": fileURLToPath(new URL("./src/", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
  },
});
