import { type IceServer } from '@rave/protocol';

/**
 * ICE servers for the browsers on this deployment.
 *
 * Phase 1 is one wifi network, where host candidates alone would do — but the
 * default is public STUN so that a peer on a second interface (a phone on
 * both wifi and a hotspot, a laptop on a VPN) still finds a working path.
 *
 * Format: comma-separated URLs. TURN needs credentials, which this cannot
 * express; when phase 2 lands, parse JSON here instead. Deliberately not
 * built yet — there is no TURN server to point at.
 */
const DEFAULT_ICE_SERVERS = 'stun:stun.l.google.com:19302';

export function iceServers(env: NodeJS.ProcessEnv = process.env): IceServer[] {
  const raw = env['ICE_SERVERS'] ?? DEFAULT_ICE_SERVERS;
  const urls = raw
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  // An empty ICE_SERVERS is a real configuration, not a mistake: it means
  // host candidates only, which is the LAN-purist setup.
  return urls.map((url) => ({ urls: url }));
}
