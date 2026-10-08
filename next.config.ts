import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Multi-stage Dockerfile (KBS-7) builds this into a self-contained
  // server bundle so the production image needs only `node server.js` —
  // no `node_modules` copy, no full Next.js install in the final stage.
  output: "standalone",

  eslint: {
    // CI runs `pnpm lint` as its own gate (KBS-6). Running it again
    // inside `next build` would duplicate the signal and double the
    // feedback latency on every build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
