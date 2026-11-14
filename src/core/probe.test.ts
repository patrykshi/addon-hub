import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpstreamManifest, probeAddonManifest } from './probe.ts';

test('parseUpstreamManifest extracts name, logo, version, and resolves relative logo paths', () => {
  const result = parseUpstreamManifest(
    {
      id: 'com.torrentio.stremio',
      name: 'Torrentio',
      version: '0.0.15',
      logo: '/images/logo_v1.png',
      resources: ['stream'],
    },
    'https://torrentio.strem.fun/manifest.json',
  );

  assert.equal(result.valid, true);
  assert.equal(result.name, 'Torrentio');
  assert.equal(result.version, '0.0.15');
  assert.equal(result.logo, 'https://torrentio.strem.fun/images/logo_v1.png');
});

test('parseUpstreamManifest rejects non-manifest payloads and unsafe logo protocols', () => {
  assert.equal(parseUpstreamManifest({ foo: 'bar' }, 'https://example.com/manifest.json').valid, false);
  assert.equal(parseUpstreamManifest('<html>error</html>', 'https://example.com/manifest.json').valid, false);

  const xssLogo = parseUpstreamManifest(
    {
      id: 'org.test.addon',
      name: 'Test Addon',
      logo: 'javascript:alert(1)',
    },
    'https://example.com/manifest.json',
  );
  assert.equal(xssLogo.valid, true);
  assert.equal(xssLogo.logo, undefined);
});

test('probeAddonManifest marks invalid or unreachable URLs as inactive without throwing', async () => {
  const invalid = await probeAddonManifest('not-a-valid-url');
  assert.equal(invalid.active, false);
  assert.ok(invalid.error);

  const unreachable = await probeAddonManifest('http://127.0.0.1:1/manifest.json', 800);
  assert.equal(unreachable.active, false);
  assert.ok(unreachable.error);
});
