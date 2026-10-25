import { IceServer } from '@rave/protocol';
import { z } from 'zod';

/**
 * ICE servers for the browsers on this deployment.
 *
 * Phase 1 is one wifi network, where host candidates alone would do — but the
 * default is public STUN so that a peer on a second interface (a phone on
 * both wifi and a hotspot, a laptop on a VPN) still finds a working path.
 *
 * Format: comma-separated URLs. For TURN, which needs credentials, set
 * CF_TURN_KEY_ID and CF_TURN_API_TOKEN instead: see {@link refreshTurn}.
 */
const DEFAULT_ICE_SERVERS = 'stun:stun.l.google.com:19302';

/** Cloudflare's short-lived TURN credentials, once fetched. Overrides ICE_SERVERS. */
let turn: IceServer[] | undefined;

export function iceServers(env: NodeJS.ProcessEnv = process.env): IceServer[] {
  if (turn) return turn;
  const raw = env['ICE_SERVERS'] ?? DEFAULT_ICE_SERVERS;
  const urls = raw
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  // An empty ICE_SERVERS is a real configuration, not a mistake: it means
  // host candidates only, which is the LAN-purist setup.
  return urls.map((url) => ({ urls: url }));
}

const TTL_SECONDS = 86_400;

const Generated = z.object({ iceServers: z.array(IceServer) });

/**
 * Mint Cloudflare TURN credentials and keep them in {@link iceServers}.
 *
 * The API token never leaves this process; browsers only see the expiring
 * username and credential it yields. Refreshes at half the TTL, so a socket
 * is never handed credentials that are about to lapse. A failed fetch keeps
 * whatever was there (static ICE_SERVERS at first) and retries in a minute.
 * Returns a stop function, and does nothing when the key is not configured.
 */
export function refreshTurn(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
  onError: (err: unknown) => void = console.error,
): () => void {
  const keyId = env['CF_TURN_KEY_ID'];
  const token = env['CF_TURN_API_TOKEN'];
  if (!keyId || !token) return () => {};

  let timer: NodeJS.Timeout;
  const run = async (): Promise<void> => {
    let next = 60_000;
    try {
      const res = await fetchFn(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl: TTL_SECONDS }),
        },
      );
      if (!res.ok) throw new Error(`cloudflare turn: HTTP ${res.status}`);
      turn = Generated.parse(await res.json()).iceServers;
      next = (TTL_SECONDS / 2) * 1000;
    } catch (err) {
      onError(err);
    }
    timer = setTimeout(() => void run(), next);
    timer.unref();
  };
  void run();
  return () => {
    clearTimeout(timer);
    turn = undefined;
  };
}
