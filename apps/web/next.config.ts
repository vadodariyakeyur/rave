import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactCompiler: true,
  // `realtime` is reached through Caddy in dev and prod alike, so the browser
  // only ever sees same-origin /ws — no mixed-content, no CORS.
  transpilePackages: ['@rave/protocol'],
};

export default nextConfig;
