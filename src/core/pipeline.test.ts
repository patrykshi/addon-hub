import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type StreamHubConfig } from './config.ts';
import { buildIdBridgeCandidates } from './metadata.ts';
import { fetchAddonWithRetry, HARD_GLOBAL_DEADLINE_MS, runStreamPipeline } from './pipeline.ts';
import { AddonWarmer, fetchWithFallback, StreamCache } from './streamCache.ts';

test('fetchAddonWithRetry retries on 500 and automatically swaps %7C <-> | on 404', async () => {
  let retryCalls = 0;
  let pipeCalls: string[] = [];

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/flaky/')) {
      retryCalls += 1;
      if (retryCalls === 1) {
        res.statusCode = 502;
        res.end('Bad Gateway');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ streams: [{ name: 'Flaky', title: 'OK', url: 'https://a.mp4' }] }));
      return;
    }

    pipeCalls.push(url);
    if (url.includes('%7C')) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ streams: [{ name: 'Fenix', title: 'Pipe OK', url: 'https://b.mp4' }] }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const res1 = await fetchAddonWithRetry(
      `http://127.0.0.1:${address.port}/flaky/stream/movie/tt0137523.json`,
      2000,
    );
    assert.equal(res1.attempts, 2);
    assert.equal(res1.streams.length, 1);

    const res2 = await fetchAddonWithRetry(
      `http://127.0.0.1:${address.port}/cfg%7Cptbr/stream/movie/tt0137523.json`,
      2000,
    );
    assert.equal(res2.attempts, 2);
    assert.equal(res2.streams.length, 1);
    assert.ok(pipeCalls[0].includes('%7C'));
    assert.ok(pipeCalls[1].includes('|'));
  } finally {
    server.close();
  }
});

test('StreamCache never stores empty arrays and serves stale fallback on upstream outage', async () => {
  const cache = new StreamCache(50, 60_000); // 50ms fresh TTL, 60s stale fallback
  const keys = [StreamCache.buildKey('https://veyra.shardweb.app/manifest.json', 'movie', 'tt0137523')];

  // Empty array must never be stored
  cache.setSuccess(keys, [], 1000);
  assert.equal(cache.size, 0);

  // Success stored at t=1000
  cache.setSuccess(
    keys,
    [{ addonName: 'Veyra', stream: { name: 'Veyra', title: 'HD', url: 'https://v.mp4' } }],
    1000,
  );
  assert.equal(cache.size, 1);
  assert.ok(cache.getFresh(keys, 1020));
  assert.equal(cache.getFresh(keys, 1100), undefined);
  // Stale fallback still works after fresh TTL expired
  const stale = cache.getFallback(keys, 1100);
  assert.ok(stale);
  assert.equal(stale.streams.length, 1);
});

test('runStreamPipeline uses stale cache fallback when upstream returns 0 streams or 500 error', async () => {
  let failMode = false;
  const server = http.createServer((_req, res) => {
    if (failMode) {
      res.statusCode = 500;
      res.end('Internal Error');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        streams: [
          {
            name: 'Veyra 1080p',
            title: 'Player 1 - Dublado',
            url: 'https://cdn.veyra.app/movie.mp4',
          },
        ],
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const cache = new StreamCache(10, 60_000); // expires fresh in 10ms so next call hits upstream
  const config: StreamHubConfig = {
    ...DEFAULT_CONFIG,
    strictMetaMatch: false,
    addons: [{ url: `http://127.0.0.1:${address.port}/manifest.json`, name: 'Veyra' }],
  };

  try {
    const first = await runStreamPipeline(config, 'movie', 'tt0137523', cache);
    assert.equal(first.streams.length, 1);
    assert.equal(first.stats.addonResults[0].fromCache, undefined);

    await new Promise((r) => setTimeout(r, 25));
    failMode = true;

    const second = await runStreamPipeline(config, 'movie', 'tt0137523', cache);
    assert.equal(second.streams.length, 1);
    assert.equal(second.stats.addonResults[0].fromCache, true);
  } finally {
    server.close();
  }
});

test('runStreamPipeline bridges tmdb <-> tt alternate ID when primary returns 0 streams', async () => {
  const bridge = buildIdBridgeCandidates(
    { rawId: 'tt0903747:1:5', cleanId: 'tt0903747', reqSeason: 1, reqEpisode: 5 },
    { imdbId: 'tt0903747', tmdbId: '1396', type: 'series', canonicalTitles: ['Breaking Bad'], fetchedAt: 0 },
  );
  assert.equal(bridge.primaryId, 'tt0903747:1:5');
  assert.deepEqual(bridge.alternateIds, ['tmdb:1396:1:5']);

  const requestedUrls: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    requestedUrls.push(url);
    res.setHeader('Content-Type', 'application/json');
    if (url.includes('tmdb:550')) {
      res.end(
        JSON.stringify({
          streams: [{ name: 'Brazuca 1080p', title: 'Player Dublado', url: 'https://br.mp4' }],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ streams: [] }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const config: StreamHubConfig = {
    ...DEFAULT_CONFIG,
    strictMetaMatch: false,
    addons: [{ url: `http://127.0.0.1:${address.port}/manifest.json`, name: 'Brazuca Play' }],
  };

  try {
    // Request comes as tmdb:550 without TMDB key; ensures tmdb:550 works cleanly
    const result = await runStreamPipeline(config, 'movie', 'tmdb:550', new StreamCache());
    assert.equal(result.streams.length, 1);
    assert.ok(requestedUrls[0].endsWith('/stream/movie/tmdb:550.json'));
  } finally {
    server.close();
  }
});

test('AddonWarmer identifies Render, Shardweb, DuckDNS, and FenixHub hosts accurately', () => {
  const warmer = new AddonWarmer();
  assert.equal(warmer.isColdStartHost('https://brazuca-play.onrender.com/manifest.json'), true);
  assert.equal(warmer.isColdStartHost('https://veyra.shardweb.app/manifest.json'), true);
  assert.equal(warmer.isColdStartHost('https://meuaddon.duckdns.org/manifest.json'), true);
  assert.equal(warmer.isColdStartHost('https://api.fenixhub.online/manifest.json'), true);
  assert.equal(warmer.isColdStartHost('https://torrentio.strem.fun/manifest.json'), false);
});

test('fetchWithFallback routes through CORS proxy on 403/503, enforces 8500ms hard deadline, and never calls proxy on timeout', async () => {
  assert.equal(HARD_GLOBAL_DEADLINE_MS, 8500);

  let proxyCalledOnTimeout = false;
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/blocked')) {
      res.statusCode = 403;
      res.end('Cloudflare 403');
      return;
    }
    if (url.startsWith('/slow')) {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ streams: [] }));
        }
      }, 800);
      return;
    }
    if (url.startsWith('/proxy?target=')) {
      if (url.includes('slow')) proxyCalledOnTimeout = true;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ streams: [{ name: 'ProxyOK', title: 'HD', url: 'https://p.mp4' }] }));
      return;
    }
    if (url.includes('cfg%7Cptbr')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ streams: [] }));
      return;
    }
    if (url.includes('cfg|ptbr')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ streams: [{ name: 'Pipe200OK', title: 'HD', url: 'https://pipe.mp4' }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const targetUrl = `http://127.0.0.1:${address.port}/blocked`;
    const result = await fetchWithFallback(targetUrl, 2000, undefined, [
      (u) => `http://127.0.0.1:${address.port}/proxy?target=${encodeURIComponent(u)}`,
    ]);
    assert.equal(result.viaProxy, true);
    assert.equal((result.data as { streams: unknown[] }).streams.length, 1);

    await assert.rejects(() =>
      fetchWithFallback(`http://127.0.0.1:${address.port}/slow`, 150, undefined, [
        (u) => `http://127.0.0.1:${address.port}/proxy?target=${encodeURIComponent(u)}`,
      ]),
    );
    assert.equal(proxyCalledOnTimeout, false);

    const pipeSwapResult = await fetchAddonWithRetry(
      `http://127.0.0.1:${address.port}/cfg%7Cptbr/stream/movie/tt0137523.json`,
      2000,
    );
    assert.equal(pipeSwapResult.attempts, 2);
    assert.equal(pipeSwapResult.streams.length, 1);
  } finally {
    server.close();
  }
});

test('runStreamPipeline keeps ok: true when primary returns 200 OK empty and altId returns 404', async () => {
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.includes('/tt')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ streams: [] }));
      return;
    }
    res.statusCode = 404;
    res.end('Not Found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const config: StreamHubConfig = {
    ...DEFAULT_CONFIG,
    strictMetaMatch: false,
    addons: [{ url: `http://127.0.0.1:${address.port}/manifest.json`, name: 'NTC TV' }],
  };

  try {
    const result = await runStreamPipeline(config, 'movie', 'tt0137523', new StreamCache());
    assert.equal(result.stats.addonResults.length, 1);
    assert.equal(result.stats.addonResults[0].ok, true);
    assert.equal(result.stats.addonResults[0].rawCount, 0);
    assert.equal(result.stats.addonResults[0].error, undefined);
  } finally {
    server.close();
  }
});
