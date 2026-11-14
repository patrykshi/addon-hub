import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeConfigBase64Url,
  encodeConfigBase64Url,
  getAddonStreamEndpoint,
  normalizeManifestUrl,
  type StreamHubConfig,
} from './config.ts';

test('normalizeManifestUrl normalizes stremio://, base paths, and trailing slashes', () => {
  assert.equal(
    normalizeManifestUrl('stremio://torrentio.strem.fun/manifest.json'),
    'https://torrentio.strem.fun/manifest.json',
  );
  assert.equal(
    normalizeManifestUrl('https://comet.elfhosted.com/'),
    'https://comet.elfhosted.com/manifest.json',
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
});

test('encodeConfigBase64Url and decodeConfigBase64Url roundtrip cleanly with UTF-8', () => {
  const input: StreamHubConfig = {
    addons: [
      { url: 'https://torrentio.strem.fun/manifest.json', name: 'Torrentio BR' },
      { url: 'https://nuviostreams.hayd.uk/manifest.json', name: 'NuvioStreams' },
    ],
    resolutions: ['2160p', '1080p'],
    allowUnknownRes: false,
    languageMode: 'only_ptbr',
    strictMetaMatch: true,
    timeoutMs: 8000,
    tmdbApiKey: 'tmdb_key_123',
  };

  const encoded = encodeConfigBase64Url(input);
  assert.ok(!encoded.includes('+'));
  assert.ok(!encoded.includes('/'));
  assert.ok(!encoded.includes('='));

  const decoded = decodeConfigBase64Url(encoded);
  assert.deepEqual(decoded, input);
});

test('decodeConfigBase64Url falls back safely on malformed input', () => {
  const decoded = decodeConfigBase64Url('%%%invalid%%%');
  assert.equal(decoded.strictMetaMatch, true);
  assert.equal(decoded.timeoutMs, 6500);
  assert.deepEqual(decoded.addons, []);
});
