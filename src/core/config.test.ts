import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeConfigBase64Url,
  encodeConfigBase64Url,
  getAddonStreamEndpoint,
  normalizeManifestUrl,
  prepareUpdatedAddonEntry,
  type StreamHubConfig,
} from './config.ts';

test('normalizeManifestUrl normalizes stremio://, base paths, trailing slashes, and complex FenixFlix config paths', () => {
  assert.equal(
    normalizeManifestUrl('stremio://torrentio.strem.fun/manifest.json'),
    'https://torrentio.strem.fun/manifest.json',
  );
  assert.equal(
    normalizeManifestUrl('https://comet.elfhosted.com/'),
    'https://comet.elfhosted.com/manifest.json',
  );
  assert.equal(
    normalizeManifestUrl(
      'https://fenixflix.fenixhub.online/qualities=4k,1080p,720p,sd%7Caudio=dublado,legendado%7Ccatalogs=filmes,series/manifest.json',
    ),
    'https://fenixflix.fenixhub.online/qualities=4k,1080p,720p,sd%7Caudio=dublado,legendado%7Ccatalogs=filmes,series/manifest.json',
  );
  assert.equal(
    normalizeManifestUrl(
      'https://fenixflix.fenixhub.online/qualities=4k,1080p|audio=dublado/manifest.json',
    ),
    'https://fenixflix.fenixhub.online/qualities=4k,1080p|audio=dublado/manifest.json',
  );
  assert.throws(() => normalizeManifestUrl('not-a-url'));
});

test('getAddonStreamEndpoint strips /manifest.json and keeps literal colons, pipes, and query params', () => {
  assert.equal(
    getAddonStreamEndpoint('https://torrentio.strem.fun/manifest.json', 'series', 'tt0903747:1:5'),
    'https://torrentio.strem.fun/stream/series/tt0903747:1:5.json',
  );
  assert.equal(
    getAddonStreamEndpoint(
      'https://torrentio.strem.fun/providers=yts|torbox=TOKEN123/manifest.json',
      'series',
      'tt0903747:1:5',
    ),
    'https://torrentio.strem.fun/providers=yts|torbox=TOKEN123/stream/series/tt0903747:1:5.json',
  );
  assert.equal(
    getAddonStreamEndpoint('https://vetela.cc/addon/manifest.json?token=abc', 'movie', 'tt0137523'),
    'https://vetela.cc/addon/stream/movie/tt0137523.json?token=abc',
  );
  assert.equal(
    getAddonStreamEndpoint('https://vetela.cc/addon/manifest.json', 'series', 'tt0903747:1:5.json'),
    'https://vetela.cc/addon/stream/series/tt0903747:1:5.json',
  );
});

test('encodeConfigBase64Url uses compact Schema v2 without logo and decodeConfigBase64Url maintains 100% v1/v2 compatibility', () => {
  const inputWithLogos: StreamHubConfig = {
    addons: [
      {
        url: 'https://torrentio.strem.fun/manifest.json',
        name: 'Torrentio BR',
        logo: 'https://torrentio.strem.fun/images/logo_v1_very_long_url.png',
      },
      {
        url: 'https://nuviostreams.hayd.uk/manifest.json',
        name: 'NuvioStreams',
        logo: 'https://nuviostreams.hayd.uk/logo.png',
      },
      {
        url: 'http://127.0.0.1:8080/manifest.json',
        name: 'Local Test',
      },
    ],
    resolutions: ['2160p', '1080p', '720p', '480p'],
    allowUnknownRes: true,
    languageMode: 'prioritize_ptbr',
    strictMetaMatch: true,
    timeoutMs: 6500,
    tmdbApiKey: '',
  };

  const encoded = encodeConfigBase64Url(inputWithLogos);
  assert.ok(!encoded.includes('+'));
  assert.ok(!encoded.includes('/'));
  assert.ok(!encoded.includes('='));

  const rawJson = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
  assert.equal(rawJson.v, 2);
  assert.deepEqual(rawJson.a, [
    ['torrentio.strem.fun', 'Torrentio BR'],
    ['nuviostreams.hayd.uk', 'NuvioStreams'],
    ['http://127.0.0.1:8080', 'Local Test'],
  ]);
  // Default fields and logo must be omitted
  assert.equal(rawJson.r, undefined);
  assert.equal(rawJson.u, undefined);
  assert.equal(rawJson.l, undefined);
  assert.equal(rawJson.s, undefined);
  assert.equal(rawJson.t, undefined);
  assert.equal(rawJson.k, undefined);
  assert.equal(JSON.stringify(rawJson).includes('logo'), false);

  const decoded = decodeConfigBase64Url(encoded);
  assert.deepEqual(decoded, {
    addons: [
      { url: 'https://torrentio.strem.fun/manifest.json', name: 'Torrentio BR' },
      { url: 'https://nuviostreams.hayd.uk/manifest.json', name: 'NuvioStreams' },
      { url: 'http://127.0.0.1:8080/manifest.json', name: 'Local Test' },
    ],
    resolutions: ['2160p', '1080p', '720p', '480p'],
    allowUnknownRes: true,
    languageMode: 'prioritize_ptbr',
    strictMetaMatch: true,
    timeoutMs: 6500,
    tmdbApiKey: '',
  });

  // Non-default overrides roundtrip cleanly in v2
  const customInput: StreamHubConfig = {
    addons: [{ url: 'https://vetela.cc/addon/manifest.json?token=abc', name: 'VêTela' }],
    resolutions: ['2160p', '1080p'],
    allowUnknownRes: false,
    languageMode: 'only_ptbr',
    strictMetaMatch: false,
    timeoutMs: 8000,
    tmdbApiKey: 'tmdb_key_123',
  };
  assert.deepEqual(decodeConfigBase64Url(encodeConfigBase64Url(customInput)), customInput);

  // Legacy v1 Base64URL payload still decodes cleanly
  const legacyV1Payload = {
    addons: [{ url: 'https://torrentio.strem.fun/manifest.json', name: 'Torrentio Legacy', logo: 'https://example.com/a.png' }],
    resolutions: ['1080p'],
    allowUnknownRes: false,
    languageMode: 'only_ptbr',
    strictMetaMatch: true,
    timeoutMs: 7000,
    tmdbApiKey: 'legacy_key',
  };
  const legacyEncoded = Buffer.from(JSON.stringify(legacyV1Payload), 'utf-8').toString('base64url');
  const legacyDecoded = decodeConfigBase64Url(legacyEncoded);
  assert.equal(legacyDecoded.addons[0].url, 'https://torrentio.strem.fun/manifest.json');
  assert.equal(legacyDecoded.addons[0].name, 'Torrentio Legacy');
  assert.equal(legacyDecoded.languageMode, 'only_ptbr');
  assert.equal(legacyDecoded.tmdbApiKey, 'legacy_key');
});

test('decodeConfigBase64Url falls back safely on malformed input', () => {
  const decoded = decodeConfigBase64Url('%%%invalid%%%');
  assert.equal(decoded.strictMetaMatch, true);
  assert.equal(decoded.timeoutMs, 6500);
  assert.deepEqual(decoded.addons, []);
});

test('prepareUpdatedAddonEntry updates HTTPS URL, prevents duplicates, and clears stale logo when URL changes', () => {
  const existing = [
    {
      url: 'https://antigo.example/manifest.json',
      name: 'Addon Antigo',
      logo: 'https://antigo.example/logo.png',
    },
    {
      url: 'https://torrentio.strem.fun/manifest.json',
      name: 'Torrentio',
    },
  ];

  const updated = prepareUpdatedAddonEntry(
    existing,
    'https://antigo.example/manifest.json',
    'https://novo-mirror.example/',
    'Novo Mirror',
  );
  assert.deepEqual(updated, {
    url: 'https://novo-mirror.example/manifest.json',
    name: 'Novo Mirror',
  });

  const renamedOnly = prepareUpdatedAddonEntry(
    existing,
    'https://antigo.example/manifest.json',
    'https://antigo.example/manifest.json',
    'Nome Editado',
  );
  assert.deepEqual(renamedOnly, {
    url: 'https://antigo.example/manifest.json',
    name: 'Nome Editado',
    logo: 'https://antigo.example/logo.png',
  });

  assert.throws(
    () =>
      prepareUpdatedAddonEntry(
        existing,
        'https://antigo.example/manifest.json',
        'https://torrentio.strem.fun',
      ),
    /já está na sua lista/,
  );
});
