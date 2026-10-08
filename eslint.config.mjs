import { FlatCompat } from "@eslint/eslintrc";
import boundaries from "eslint-plugin-boundaries";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

// Module boundaries, enforced in CI rather than left to review attention
// (spec/file-structure's import matrix). A violation here fails the
// build — these four rules are the ones that cause invisible-until-prod
// failures: a secret leaking into the browser bundle, or a blank
// link-preview card from a client component at a public page root.
const elements = [
  { type: "shared", pattern: "src/shared/**" },
  { type: "client", pattern: "src/client/**" },
  { type: "components-ui", pattern: "src/components/ui/**" },
  { type: "components-public", pattern: "src/components/public/**" },
  { type: "components-admin", pattern: "src/components/admin/**" },
  { type: "server-db", pattern: "src/server/db/**" },
  { type: "server-services", pattern: "src/server/services/**" },
  { type: "server-other", pattern: "src/server/**" },
  { type: "config", pattern: "src/config/**" },
  { type: "app", pattern: "app/**" },
  { type: "middleware", pattern: "middleware.ts" },
];

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    plugins: { boundaries },
    settings: {
      "boundaries/include": ["**/*.ts", "**/*.tsx"],
      "boundaries/elements": elements,
      "boundaries/ignore": ["**/*.test.ts", "**/*.test.tsx", "tests/**"],
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "allow",
          rules: [
            {
              from: ["app"],
              disallow: ["server-db"],
              message:
                "app/** must not import src/server/db directly — call a service in src/server/services instead (spec/file-structure).",
            },
            {
              from: ["shared"],
              disallow: [
                "server-db",
                "server-services",
                "server-other",
                "client",
                "components-ui",
                "components-public",
                "components-admin",
                "app",
                "config",
              ],
              message:
                "src/shared/** may import nothing but zod and other src/shared modules — it is bundled into the browser, and a secret imported here is published (spec/file-structure).",
            },
            {
              from: ["server-db", "server-services", "server-other", "config"],
              disallow: ["client", "components-ui", "components-public", "components-admin"],
              message:
                "src/server/** must never import src/client/** or src/components/** — it drags React/browser code into server-only code, the worker and scripts (spec/file-structure).",
            },
            {
              from: ["client", "components-ui", "components-public", "components-admin"],
              disallow: ["config"],
              message:
                "src/client/** and src/components/** must never import src/config/** — env.ts holds DATABASE_URL, SESSION_SECRET and the mail keys, and a browser-bundled import publishes them. Pass the value down as a prop from a server component instead (spec/file-structure).",
            },
            {
              from: ["components-public"],
              disallow: ["components-admin", "server-db", "server-services", "server-other"],
              message:
                "src/components/public/** must never import src/components/admin/** or any src/server/** — admin code must never ship in a bride's bundle (spec/file-structure).",
            },
            {
              from: ["middleware"],
              disallow: ["server-db", "server-services"],
              message:
                "middleware.ts runs pipeline steps 1-3 only (request id, logging, security headers) and must never touch the database (spec/architecture).",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "drizzle/migrations/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
