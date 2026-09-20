import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactCompiler: true,
  // Phase 1 is joined from phones by LAN IP, which is a cross-origin host as
  // far as the dev server is concerned. Without this it blocks /_next/hmr,
  // the client runtime never finishes hydrating, and every form on the phone
  // renders but stays dead — typing changes nothing and the buttons never
  // enable. Same RAVE_HOST the Caddyfile and Makefile already agree on.
  // Dev-only; the production build never reads it.
  allowedDevOrigins: [process.env.RAVE_HOST ?? 'localhost'],
  // `realtime` is reached through Caddy in dev and prod alike, so the browser
  // only ever sees same-origin /ws — no mixed-content, no CORS.
  transpilePackages: ['@rave/protocol'],
};

export default nextConfig;
