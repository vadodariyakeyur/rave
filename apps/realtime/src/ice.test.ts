import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { iceServers, refreshTurn } from './ice.ts';

describe('refreshTurn', () => {
  const env = { CF_TURN_KEY_ID: 'kid', CF_TURN_API_TOKEN: 'secret' };
  const turn = { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' };

  it('does nothing without a key', () => {
    let called = false;
    refreshTurn({}, (async () => { called = true; }) as never)();
    assert.equal(called, false);
  });

  it('serves Cloudflare credentials once fetched, and the static list again after stop', async () => {
    let seen: { url: string; auth: string } | undefined;
    const stop = refreshTurn(env, (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>)['authorization']! };
      return { ok: true, json: async () => ({ iceServers: [turn] }) };
    }) as never);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(iceServers({}), [turn]);
    assert.equal(seen?.auth, 'Bearer secret');
    assert.match(seen!.url, /keys\/kid\/credentials\/generate-ice-servers$/);
    stop();
    assert.deepEqual(iceServers({}), [{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('keeps the static list when Cloudflare fails', async () => {
    const errors: unknown[] = [];
    const stop = refreshTurn(env, (async () => ({ ok: false, status: 500 })) as never, (e) => errors.push(e));
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    assert.deepEqual(iceServers({}), [{ urls: 'stun:stun.l.google.com:19302' }]);
    stop();
  });
});

describe('iceServers', () => {
  it('defaults to public STUN when nothing is configured', () => {
    assert.deepEqual(iceServers({}), [{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    assert.deepEqual(iceServers({ ICE_SERVERS: 'stun:a:1, stun:b:2 ' }), [
      { urls: 'stun:a:1' },
      { urls: 'stun:b:2' },
    ]);
  });

  it('treats an empty value as host candidates only, not as unset', () => {
    // Overriding the default with nothing is how a LAN-only deployment says
    // "do not talk to Google" — it must not silently fall back.
    assert.deepEqual(iceServers({ ICE_SERVERS: '' }), []);
  });
});
