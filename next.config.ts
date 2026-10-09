import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Multi-stage Dockerfile (KBS-7) builds this into a self-contained
  // server bundle so the production image needs only `node server.js` —
  // no `node_modules` copy, no full Next.js install in the final stage.
  output: "standalone",
  serverExternalPackages: ["sharp", "detect-libc"],

  outputFileTracingIncludes: { "*": ["src/server/auth/data/common-passwords.txt.gz"] },

  outputFileTracingExcludes: {
    // `typescript` is traced in only because Next transpiles this config
    // file; the standalone server inlines the config and never loads it, so
    // shipping 8.7MB of compiler would break KBS-7's "no devDependencies in
    // the runtime image". The base image is glibc (bookworm-slim), so the
    // musl prebuilds of sharp/@node-rs/argon2 are dead weight too.
    "*": ["node_modules/typescript/**", "node_modules/**/*musl*/**"],
  },

  eslint: {
    // CI runs `pnpm lint` as its own gate (KBS-6). Running it again
    // inside `next build` would duplicate the signal and double the
    // feedback latency on every build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
