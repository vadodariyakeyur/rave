import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from './metrics.ts';

describe('Metrics', () => {
  it('reads the live gauges at scrape time, not when they were set', async () => {
    // The whole reason these are gauges over the registry: a counter pair
    // would be a second copy of the roster.
    const live = { size: 0, peerCount: 0 };
    const metrics = new Metrics(live);

    live.size = 2;
    live.peerCount = 5;
    const { body, contentType } = await metrics.render();

    assert.match(body, /^rave_rooms_live 2$/m);
    assert.match(body, /^rave_peers_live 5$/m);
    assert.match(contentType, /text\/plain/);
  });
});
